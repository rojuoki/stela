/**
 * STELA TokenPool — bearer token management for X API v2
 *
 * Reads tokens from ENV:
 *   X_BEARER_TOKENS="t1,t2,t3"   (multiple — enables parallel excavation)
 *   X_BEARER_TOKEN="t1"           (single — backward-compat fallback)
 *
 * Rules:
 *   - Each job is assigned one token at start and uses it until completion.
 *   - On 429: the token enters cooldown until x-rate-limit-reset.
 *   - M = min(tokenCount, M_MAX) sets the max parallel excavation slots.
 */

/** Hard cap on parallel excavations regardless of token count. */
const M_MAX = 3;

export interface TokenState {
  /** Epoch ms until which this token must not be used. Set on 429. */
  cooldownUntil?: number;
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

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Assign a free, non-cooldown token to a job.
   * Returns null if no token is currently available.
   */
  acquireToken(jobId: string): string | null {
    const now = Date.now();
    const entry = this._entries.find(
      (e) =>
        !e.assignedJobId &&
        (!e.state.cooldownUntil || e.state.cooldownUntil <= now),
    );
    if (!entry) return null;
    entry.assignedJobId = jobId;
    return entry.token;
  }

  /** Release a token back to the pool when its job completes. */
  releaseToken(token: string): void {
    const entry = this._entries.find((e) => e.token === token);
    if (entry) entry.assignedJobId = undefined;
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
   * Handle a 429 response: set the token's cooldown to the reset epoch.
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

  /** True if at least one token is free and not in cooldown. */
  hasAvailableToken(): boolean {
    const now = Date.now();
    return this._entries.some(
      (e) =>
        !e.assignedJobId &&
        (!e.state.cooldownUntil || e.state.cooldownUntil <= now),
    );
  }

  /** Number of currently assigned (running) tokens. */
  get runningCount(): number {
    return this._entries.filter((e) => !!e.assignedJobId).length;
  }

  /**
   * Earliest epoch ms at which any cooldown-bound token becomes available.
   * Returns 0 if no tokens are currently in cooldown.
   * Used by the queue to schedule automatic retry after global rate limit.
   */
  earliestCooldownEnd(): number {
    const now = Date.now();
    const active = this._entries
      .filter((e) => e.state.cooldownUntil && e.state.cooldownUntil > now)
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
}

export const tokenPool = new TokenPool();
