/**
 * STELA TokenPool — bearer token management for X API v2
 *
 * Reads tokens from ENV:
 *   X_BEARER_TOKENS="t1,t2,t3"   (multiple — enables parallel excavation)
 *   X_BEARER_TOKEN="t1"           (single — backward-compat fallback)
 *
 * Cooldown model:
 *   hard cooldown  — set on 429; blocks token until x-rate-limit-reset.
 *   soft cooldown  — set on job terminal exit (success/fail/cancel); gives the
 *                    token a recovery window (TOKEN_RECOVERY_SECONDS, default 900)
 *                    before it can be assigned to the next job. Skipped on 429
 *                    suspend because hard cooldown already handles that case.
 *
 * Rules:
 *   - Each job is assigned one token at start and uses it until completion.
 *   - A token is available only when now >= max(hardCooldownUntil, softCooldownUntil).
 *   - M = min(tokenCount, M_MAX) sets the max parallel excavation slots.
 */

/** Hard cap on parallel excavations regardless of token count. */
const M_MAX = 3;

/**
 * Recovery window after a job finishes (success / fail / cancel).
 * Prevents immediately recycling a just-used token to the next job.
 * Override via TOKEN_RECOVERY_SECONDS env (default 900 = 15 min).
 */
const TOKEN_RECOVERY_MS =
  parseInt(process.env.TOKEN_RECOVERY_SECONDS ?? "900", 10) * 1000;

export interface TokenState {
  /** Epoch ms until which this token must not be used (hard — set on 429). */
  cooldownUntil?: number;
  /**
   * Epoch ms until which this token should not be assigned to a new job (soft —
   * set when a job exits in a terminal state other than 429 suspend).
   */
  softCooldownUntilMs?: number;
  /** Last known x-rate-limit-remaining value. */
  remaining?: number;
  /** Last known x-rate-limit-reset epoch (seconds). */
  reset?: number;
}

interface TokenEntry {
  readonly token: string;
  state: TokenState;
  /** Job ID currently using this token, or undefined if free. */
  assignedJobId?: string;
}

class TokenPool {
  private readonly _entries: TokenEntry[];

  /** Max parallel excavations = min(tokenCount, M_MAX). At least 1. */
  readonly M: number;

  constructor() {
    const raw = process.env.X_BEARER_TOKENS ?? process.env.X_BEARER_TOKEN ?? "";
    const tokens = raw
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    this._entries = tokens.map((token) => ({ token, state: {} }));
    // M is at least 1 so a single-token deployment always works.
    this.M = Math.min(Math.max(tokens.length, 1), M_MAX);

    if (tokens.length === 0) {
      console.warn(
        "[tokenPool] No tokens in X_BEARER_TOKENS / X_BEARER_TOKEN. " +
          "xfetch will fall back to reading X_BEARER_TOKEN directly.",
      );
    } else {
      console.log(`[tokenPool] ${tokens.length} token(s), M=${this.M}`);
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Epoch ms at which the token becomes available for assignment.
   * Combines hard cooldown (429) and soft cooldown (post-job recovery).
   */
  private _availableAtMs(entry: TokenEntry): number {
    return Math.max(
      entry.state.cooldownUntil ?? 0,
      entry.state.softCooldownUntilMs ?? 0,
    );
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Assign a token to a job using a two-pass strategy:
   *
   *   Pass 1 — prefer tokens past BOTH cooldowns (ideal).
   *   Pass 2 — fall back to tokens past hard cooldown only (soft-cooling but
   *             no better option — handles single-token deployments and the
   *             case where all recovered tokens are already running).
   *
   * Hard cooldown (429) is always respected and never bypassed.
   * Returns null only when every token is hard-blocked or already assigned.
   */
  acquireToken(jobId: string): string | null {
    const now = Date.now();

    // Pass 1: fully available (past both hard and soft cooldowns).
    let entry = this._entries.find(
      (e) => !e.assignedJobId && now >= this._availableAtMs(e),
    );

    // Pass 2: soft-cooling only (hard cooldown cleared) — assign as fallback.
    if (!entry) {
      entry = this._entries.find(
        (e) =>
          !e.assignedJobId &&
          !(e.state.cooldownUntil && e.state.cooldownUntil > now) &&
          !!(e.state.softCooldownUntilMs && e.state.softCooldownUntilMs > now),
      );
    }

    if (!entry) return null;
    entry.assignedJobId = jobId;
    const idx = this.getTokenIndex(entry.token);
    const avail = this._availableAtMs(entry);
    const label = avail > now ? `soft-cooldown bypass, was ${new Date(avail).toISOString()}` : "recovered";
    console.log(`[tokenPool] token[${idx}] acquired by job ${jobId} (${label})`);
    return entry.token;
  }

  /** Release a token back to the pool (removes job assignment only). */
  releaseToken(token: string): void {
    const entry = this._entries.find((e) => e.token === token);
    if (entry) entry.assignedJobId = undefined;
  }

  /**
   * Mark a token as recently used, applying the soft cooldown window.
   * Call this on every terminal job exit (success / fail / cancel).
   * Do NOT call on 429 suspend — hard cooldown handles that path.
   */
  markUsed(token: string): void {
    const entry = this._entries.find((e) => e.token === token);
    if (!entry) return;
    const softUntil = Date.now() + TOKEN_RECOVERY_MS;
    entry.state.softCooldownUntilMs = softUntil;
    const idx = this.getTokenIndex(token);
    console.log(
      `[tokenPool] token[${idx}] soft cooldown until ${new Date(softUntil).toISOString()} (${Math.ceil(TOKEN_RECOVERY_MS / 60_000)}m recovery)`,
    );
  }

  // ── State updates from API responses ──────────────────────────────────────

  /**
   * Update remaining / reset counters from X API response headers.
   * Called after every fetch (success or non-network-error failure).
   */
  updateFromHeaders(token: string, headers: Headers): void {
    const entry = this._entries.find((e) => e.token === token);
    if (!entry) return;
    const remaining = headers.get("x-rate-limit-remaining");
    const reset = headers.get("x-rate-limit-reset");
    if (remaining !== null) entry.state.remaining = parseInt(remaining, 10);
    if (reset !== null) entry.state.reset = parseInt(reset, 10);
  }

  /**
   * Handle a 429 response: set the token's hard cooldown to the reset epoch.
   * Returns the cooldown-end time in ms so the caller can schedule retries.
   */
  onRateLimit(token: string, resetEpochSeconds: number): number {
    const entry = this._entries.find((e) => e.token === token);
    const cooldownUntilMs = resetEpochSeconds * 1000;
    if (entry) {
      entry.state.cooldownUntil = cooldownUntilMs;
      console.log(
        `[tokenPool] Cooldown set until ${new Date(cooldownUntilMs).toISOString()} for token …${token.slice(-6)}`,
      );
    }
    return cooldownUntilMs;
  }

  // ── Queue helpers ─────────────────────────────────────────────────────────

  /**
   * True if at least one token is unassigned and not hard-blocked.
   * Soft cooldown is intentionally ignored here: a soft-cooling token is still
   * assignable as a fallback (see acquireToken pass 2), so it counts as
   * "available" for queue-scheduling purposes.
   */
  hasAvailableToken(): boolean {
    const now = Date.now();
    return this._entries.some(
      (e) =>
        !e.assignedJobId &&
        !(e.state.cooldownUntil && e.state.cooldownUntil > now),
    );
  }

  /** Number of currently assigned (running) tokens. */
  get runningCount(): number {
    return this._entries.filter((e) => !!e.assignedJobId).length;
  }

  /**
   * Earliest epoch ms at which any unassigned, hard-blocked token's cooldown ends.
   * Returns 0 if no unassigned tokens are currently hard-blocked.
   * Used by the queue to schedule automatic retry after a rate-limit suspend.
   * Soft cooldown is not included: soft-cooling tokens are assignable as fallback
   * so they do not gate queue scheduling.
   */
  earliestCooldownEnd(): number {
    const now = Date.now();
    const active = this._entries
      .filter((e) => !e.assignedJobId && e.state.cooldownUntil && e.state.cooldownUntil > now)
      .map((e) => e.state.cooldownUntil!);
    return active.length > 0 ? Math.min(...active) : 0;
  }

  /** 0-based index of a token in the pool (for concise log labels). */
  getTokenIndex(token: string): number {
    return this._entries.findIndex((e) => e.token === token);
  }

  /** Read token state (for debugging / status endpoints). */
  getState(token: string): TokenState | undefined {
    return this._entries.find((e) => e.token === token)?.state;
  }

  /**
   * Return any pool token without acquiring it (no assignment, no cooldown check).
   * Used as a fallback for non-job API calls (e.g. user lookup) so they always
   * use a token from the pool rather than reading X_BEARER_TOKEN directly.
   * Returns undefined when the pool has no tokens at all.
   */
  peekToken(): string | undefined {
    return this._entries[0]?.token;
  }
}

export const tokenPool = new TokenPool();
