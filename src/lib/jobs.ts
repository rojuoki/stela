/**
 * STELA Job Runner — global queue with TokenPool and suspend/resume on 429.
 *
 * Design principles:
 *   ① /api/jobs/:id (GET) is read-only — it never calls register() / complete() /
 *     _launch(). Importing globalQueue from there is safe.
 *
 *   ② Each job runs exclusively with one bearer token (acquired at launch,
 *     released on any terminal state). All X API calls within a job are strictly
 *     sequential — no Promise.all.
 *
 *   ③ On 429: xfetch throws XApiStop("RATE_LIMIT") immediately (no sleep loop).
 *     The job runner catches it, marks the job QUEUED with resume_at set in DB,
 *     releases the token, and schedules a timer to re-queue it when the cooldown
 *     expires. The job restarts from scratch on resume (stateless).
 *
 *   ④ On server restart: RUNNING jobs → FAILED (SERVER_RESTART). QUEUED jobs
 *     with a future resume_at → rescheduled via timer. QUEUED jobs without
 *     resume_at → started immediately.
 *
 * Concurrency model:
 *   - _pendingIds  : jobs ready to start (no cooldown constraint).
 *   - _waitingIds  : jobs suspended due to 429; Map<jobId → resumeAtMs>.
 *   - _runningJobIds: currently executing jobs (size ≤ tokenPool.M).
 */

import { randomUUID } from "crypto";
import { getDb } from "./db";
import { excavateEarliest, type ExcavationCheckpoint, type ExcavationResult } from "./excavate";
import { captureHeld, releaseHeld } from "./repository";
import { tokenPool } from "./tokenPool";
import { XApiStop } from "./xclient";

export interface JobRecord {
  id: string;
  account_username: string;
  account_id: string | null;
  requested_limit: number;
  status: "queued" | "running" | "succeeded" | "failed" | "canceled";
  error_code: string | null;
  error_message: string | null;
  result_json: string | null;
  api_calls: number;
  fetched_count: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  hold_id: string | null;
  /** Set when a 429 suspends the job; cleared on terminal state. ISO-8601. */
  resume_at: string | null;
  /**
   * JSON-serialised ExcavationCheckpoint. Written at every safe boundary so the
   * excavation can resume from the exact last point after a 429 suspend.
   * Cleared (NULL) on any terminal state (succeeded / failed).
   */
  resume_state: string | null;
}

// ─── Global Serialization Queue ───────────────────────────────────────────────

/** Buffer added to resume timer so the token is comfortably out of cooldown. */
const RESUME_BUFFER_MS = 2_000;

class GlobalJobQueue {
  /** Jobs currently executing excavation (≤ M). */
  private _runningJobIds = new Set<string>();
  /** Jobs ready to start, FIFO. */
  private _pendingIds: string[] = [];
  /**
   * Jobs suspended due to 429.
   * Maps jobId → epoch-ms when the assigned token's cooldown ends.
   */
  private _waitingIds = new Map<string, number>();

  constructor() {
    // Eagerly initialize so restart-recovery and pending resume timers are set
    // up before the first request arrives.
    // runJobAsync is a hoisted function declaration — available here.
    try {
      this._init();
    } catch (e) {
      console.warn(
        "[queue] Init skipped (DB not ready?):",
        e instanceof Error ? e.message : e,
      );
    }
  }

  // ── Public accessors ──────────────────────────────────────────────────────

  /** First running job ID, or null (backward-compat). */
  get runningJobId(): string | null {
    const it = this._runningJobIds.values().next();
    return it.done ? null : it.value;
  }

  /** 1-based queue position in the pending list (not counting waiting). */
  positionOf(jobId: string): number | null {
    const idx = this._pendingIds.indexOf(jobId);
    return idx === -1 ? null : idx + 1;
  }

  /** Snapshot of current in-memory queue state for DevPanel display. */
  queueSnapshot(): { running: string[]; pending: string[]; waiting: string[] } {
    return {
      running: [...this._runningJobIds],
      pending: [...this._pendingIds],
      waiting: [...this._waitingIds.keys()],
    };
  }

  /**
   * Cancel a job by ID. Safe to call for any state.
   * - pending  : removed from queue immediately, DB → canceled, credit hold released.
   * - waiting  : removed from in-memory set, DB → canceled. The resume timer will
   *              see the non-"queued" status and skip without doing anything.
   * - running  : DB → canceled. runJobAsync checks before writing "succeeded" and
   *              will skip success processing, releasing the hold itself.
   * - terminal : returns false (already done).
   */
  cancelJob(jobId: string): boolean {
    const db = getDb();
    const row = db
      .prepare("SELECT status, hold_id FROM jobs WHERE id = ?")
      .get(jobId) as { status: string; hold_id: string | null } | undefined;

    if (!row) return false;
    if (["canceled", "succeeded", "failed"].includes(row.status)) return false;

    const isRunning = this._runningJobIds.has(jobId);

    // Release credit hold for non-running jobs (running jobs release in runJobAsync).
    if (!isRunning && row.hold_id) {
      releaseHeld(row.hold_id, "Job canceled by user");
    }

    // Mark canceled in DB immediately.
    db.prepare(
      "UPDATE jobs SET status = 'canceled', finished_at = ?, resume_at = NULL, resume_state = NULL WHERE id = ?",
    ).run(new Date().toISOString(), jobId);

    // Remove from in-memory structures.
    this._pendingIds = this._pendingIds.filter((id) => id !== jobId);
    this._waitingIds.delete(jobId);
    // _runningJobIds is NOT removed here: runJobAsync still holds the slot and
    // will call complete() via finally when excavateEarliest finishes naturally.

    console.log(`[queue] Job ${jobId} CANCELED (was ${row.status})`);
    return true;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Register a newly-created job (always starts as QUEUED in DB).
   * Launches immediately if a slot and token are available.
   */
  register(jobId: string): void {
    if (this._runningJobIds.size < tokenPool.M && tokenPool.hasAvailableToken()) {
      this._launch(jobId);
    } else {
      this._pendingIds.push(jobId);
      console.log(`[queue] Job ${jobId} → QUEUED (position ${this._pendingIds.length})`);
    }
  }

  /**
   * Called when a job finishes (success OR non-rate-limit failure).
   * Clears the running slot and promotes the next pending job.
   */
  complete(jobId: string): void {
    this._runningJobIds.delete(jobId);
    this._pendingIds = this._pendingIds.filter((id) => id !== jobId);
    this._startNext();
  }

  /**
   * Suspend a job after a 429: remove from running, add to waiting, schedule
   * a timer to re-queue it when the token cooldown expires.
   *
   * Called by runJobAsync; DB status + resume_at must already be written
   * before calling this.
   */
  suspend(jobId: string, resumeAtMs: number): void {
    this._runningJobIds.delete(jobId);
    this._pendingIds = this._pendingIds.filter((id) => id !== jobId);
    this._waitingIds.set(jobId, resumeAtMs);

    const delayMs = Math.max(100, resumeAtMs - Date.now()) + RESUME_BUFFER_MS;
    console.log(
      `[queue] Job ${jobId} suspended. Re-scheduling in ${Math.ceil(delayMs / 1000)}s` +
        ` (resume_at=${new Date(resumeAtMs).toISOString()})`,
    );
    setTimeout(() => this._tryResume(jobId), delayMs);

    // Free up the slot so other pending jobs can proceed.
    this._startNext();
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private _launch(jobId: string): void {
    this._runningJobIds.add(jobId);
    try {
      const now = new Date().toISOString();
      getDb()
        .prepare(
          "UPDATE jobs SET status = 'running', started_at = COALESCE(started_at, ?), resume_at = NULL, node_pid = ? WHERE id = ?",
        )
        .run(now, process.pid, jobId);
      console.log(
        `[queue] Job ${jobId} → RUNNING (${this._runningJobIds.size}/${tokenPool.M})`,
      );
    } catch (e) {
      console.error(`[queue] Failed to mark job ${jobId} RUNNING:`, e);
    }

    // runJobAsync is a hoisted function declaration.
    runJobAsync(jobId).catch((e) => {
      console.error(`[queue] Unhandled error in job ${jobId}:`, e);
      this.complete(jobId);
    });
  }

  private _startNext(): void {
    while (
      this._runningJobIds.size < tokenPool.M &&
      this._pendingIds.length > 0 &&
      tokenPool.hasAvailableToken()
    ) {
      const nextId = this._pendingIds.shift()!;
      console.log(`[queue] Starting next: ${nextId}`);
      this._launch(nextId);
    }
  }

  /** Called by the resume timer; re-queues the job if the token is free. */
  private _tryResume(jobId: string): void {
    this._waitingIds.delete(jobId);

    // Verify job still exists and is still queued (user might have canceled it).
    const row = getDb()
      .prepare("SELECT status FROM jobs WHERE id = ?")
      .get(jobId) as { status: string } | undefined;

    if (!row || row.status !== "queued") {
      console.log(
        `[queue] Resume skip: job ${jobId} status=${row?.status ?? "not found"}`,
      );
      return;
    }

    if (tokenPool.hasAvailableToken()) {
      const tokenIdx = tokenPool.M; // token index resolved in runJobAsync
      console.log(`[queue] Job ${jobId} RESUMING (re-queued)`);
      // Push to front so a resumed job has priority over brand-new ones.
      this._pendingIds.unshift(jobId);
      this._startNext();
    } else {
      // Token still in cooldown — reschedule.
      const nextEnd = tokenPool.earliestCooldownEnd();
      const delayMs = nextEnd > 0 ? Math.max(100, nextEnd - Date.now()) + RESUME_BUFFER_MS : 60_000;
      console.log(
        `[queue] Job ${jobId} resume delayed (token still in cooldown), retrying in ${Math.ceil(delayMs / 1000)}s`,
      );
      this._waitingIds.set(jobId, Date.now() + delayMs);
      setTimeout(() => this._tryResume(jobId), delayMs);
    }
  }

  private _init(): void {
    const db = getDb();
    const nowMs = Date.now();

    // Handle RUNNING jobs found in DB on startup.
    //
    // Two scenarios:
    //   A) True process restart (crash / manual kill): node_pid differs from
    //      process.pid → re-queue so the job resumes from its last checkpoint.
    //
    //   B) Turbopack HMR / lazy route compilation: a new module bundle evaluates
    //      jobs.ts in a separate context (different globalThis), constructing a
    //      second GlobalJobQueue. The job is still running in the ORIGINAL
    //      context. node_pid matches process.pid → don't re-queue; just add the
    //      job to _runningJobIds so this instance knows the slot is occupied.
    //
    // Credit holds are intentionally kept in both cases: we intend to retry or
    // continue, not to abort.
    const interrupted = db
      .prepare("SELECT id, node_pid FROM jobs WHERE status = 'running'")
      .all() as { id: string; node_pid: number | null }[];

    for (const job of interrupted) {
      if (job.node_pid === process.pid) {
        // Same process → HMR false alarm. Job is still running; just track it.
        this._runningJobIds.add(job.id);
        console.log(
          `[queue] Job ${job.id} still running in PID ${process.pid} (HMR guard) — not re-queuing`,
        );
        continue;
      }

      // Different PID (or null) → true restart. Re-queue from checkpoint.
      db.prepare(`
        UPDATE jobs
        SET status = 'queued',
            error_code = NULL,
            error_message = NULL,
            resume_at = NULL,
            node_pid = NULL
        WHERE id = ?
      `).run(job.id);
      console.log(`[queue] Job ${job.id} → RE-QUEUED (was running at init; will resume from checkpoint)`);
    }

    // Reload QUEUED jobs. Split them into "ready" vs "waiting" based on resume_at.
    const queued = db
      .prepare(
        "SELECT id, resume_at FROM jobs WHERE status = 'queued' ORDER BY created_at ASC",
      )
      .all() as { id: string; resume_at: string | null }[];

    for (const job of queued) {
      const resumeAtMs = job.resume_at ? new Date(job.resume_at).getTime() : 0;
      if (resumeAtMs > nowMs) {
        // Still in rate-limit cooldown — schedule timer to re-queue.
        this._waitingIds.set(job.id, resumeAtMs);
        const delayMs = Math.max(100, resumeAtMs - nowMs) + RESUME_BUFFER_MS;
        setTimeout(() => this._tryResume(job.id), delayMs);
        console.log(
          `[queue] Job ${job.id} WAITING_RATE_LIMIT — resume timer set (${Math.ceil(delayMs / 1000)}s)`,
        );
      } else {
        this._pendingIds.push(job.id);
      }
    }

    if (interrupted.length > 0 || queued.length > 0) {
      console.log(
        `[queue] Init: ${interrupted.length} interrupted → RE-QUEUED, ` +
          `${this._pendingIds.length} pending, ${this._waitingIds.size} waiting (rate-limit), M=${tokenPool.M}`,
      );
    }

    this._startNext();
  }
}

// ─── Singleton — survives Next.js hot-module-reload ──────────────────────────
//
// Next.js dev mode (Fast Refresh / Turbopack) re-evaluates server modules on
// every code change, creating a fresh module scope each time. A plain
// `new GlobalJobQueue()` would call _init() on every reload and incorrectly
// treat still-running jobs as server-restart casualties.
//
// Storing the instance on `globalThis` (which is NOT reset by HMR within the
// same Node process) ensures _init() runs exactly once per process lifetime,
// regardless of how many module reloads occur.
//
// In production this has no effect: modules are evaluated once at startup.
const _g = globalThis as typeof globalThis & { __stelaQueue?: GlobalJobQueue };
if (!_g.__stelaQueue) {
  _g.__stelaQueue = new GlobalJobQueue();
}
export const globalQueue: GlobalJobQueue = _g.__stelaQueue;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Compute the target tweet count for a job based on the account's creation year.
 *
 *   created_year ≤ 2012  →  50   (very old accounts: archive gaps, API limits)
 *   created_year ≤ 2018  →  75   (older accounts: moderate depth)
 *   otherwise            → 100   (recent accounts: full depth)
 *
 * Exported so callers can display the value before job creation.
 */
export function computeTargetCount(accountCreatedAt: string | null | undefined): number {
  if (!accountCreatedAt) return 100;
  const year = new Date(accountCreatedAt).getUTCFullYear();
  if (year <= 2012) return 50;
  if (year <= 2018) return 75;
  return 100;
}

/**
 * Create a new excavation job and hand it to the global queue.
 * Always inserted as QUEUED; the queue promotes it to RUNNING when a slot opens.
 * /api/jobs/:id polling NEVER calls this function.
 *
 * @param accountCreatedAt  ISO string from the accounts table (if already cached).
 *                          Used to compute the dynamic target count; defaults to 100
 *                          when the account is not yet in the local DB.
 */
export function createAndRunJob(
  username: string,
  accountCreatedAt?: string | null,
  holdId?: string,
): string {
  const db = getDb();
  const jobId = randomUUID();
  const now = new Date().toISOString();
  const targetCount = computeTargetCount(accountCreatedAt);

  db.prepare(`
    INSERT INTO jobs (id, account_username, requested_limit, hold_id, status, created_at)
    VALUES (?, ?, ?, ?, 'queued', ?)
  `).run(jobId, username.toLowerCase(), targetCount, holdId ?? null, now);

  globalQueue.register(jobId);
  return jobId;
}

/** Read-only job lookup. Never triggers X API calls. */
export function getJob(jobId: string): JobRecord | undefined {
  const db = getDb();
  return db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as
    | JobRecord
    | undefined;
}

// ─── Internal job runner (hoisted function declaration) ───────────────────────
//
// Called ONLY from GlobalJobQueue._launch(). Never called from polling endpoints.

async function runJobAsync(jobId: string): Promise<void> {
  const db = getDb();

  // Acquire a token — guaranteed available since queue checked before _launch().
  const token = tokenPool.acquireToken(jobId);
  if (!token) {
    console.error(`[jobs] No token for job ${jobId} — failing (pool exhausted)`);
    failJobInDb(jobId, "NO_TOKEN", "No bearer token available in pool");
    globalQueue.complete(jobId);
    return;
  }
  const tokenIdx = tokenPool.getTokenIndex(token);

  // Track whether this job handed off to the suspend path.
  // globalQueue.suspend() manages the queue slot itself, so we must NOT also
  // call globalQueue.complete() in the finally block for that path.
  let suspended = false;

  try {
    const jobRow = db
      .prepare("SELECT account_username, requested_limit, hold_id, resume_state, status FROM jobs WHERE id = ?")
      .get(jobId) as
      | { account_username: string; requested_limit: number; hold_id: string | null; resume_state: string | null; status: string }
      | undefined;

    if (!jobRow) {
      console.warn(`[jobs] Job ${jobId} not found — skipping`);
      return; // finally handles cleanup
    }

    // Guard: verify the job is still RUNNING before doing any work.
    // With the globalThis singleton this should always pass, but if something
    // external changes the DB status between _launch() and here, abort cleanly
    // rather than running a duplicate excavation.
    if (jobRow.status !== "running") {
      console.warn(
        `[jobs] Job ${jobId} status=${jobRow.status} at launch time (expected running) — aborting`,
      );
      return; // finally handles cleanup
    }

    const { account_username: username, requested_limit: limit, hold_id: holdId } = jobRow;

    // Restore checkpoint from previous run (if any).
    let initialCheckpoint: ExcavationCheckpoint | null = null;
    if (jobRow.resume_state) {
      try {
        initialCheckpoint = JSON.parse(jobRow.resume_state) as ExcavationCheckpoint;
        console.log(
          `[jobs] Job ${jobId} resuming from checkpoint phase=${initialCheckpoint.phase}` +
            (initialCheckpoint.phase === "collect"
              ? ` window=${initialCheckpoint.collect_window_start?.slice(0, 10)} ids=${initialCheckpoint.collected_ids?.length ?? 0}`
              : initialCheckpoint.phase === "explore_month"
                ? ` year=${initialCheckpoint.month_scan_year} month=${initialCheckpoint.next_month}`
                : ` next_year=${initialCheckpoint.next_year}`),
        );
      } catch {
        console.warn(`[jobs] Job ${jobId} corrupt resume_state — starting fresh`);
      }
    }

    // Persist checkpoint to DB at every safe boundary inside the excavation.
    // On RATE_LIMIT suspend we do NOT clear this — it survives until terminal state.
    const saveCheckpoint = (cp: ExcavationCheckpoint): void => {
      db.prepare("UPDATE jobs SET resume_state = ? WHERE id = ?").run(
        JSON.stringify(cp),
        jobId,
      );
    };

    // Progress: api_calls counter updated after every probe (display only).
    // Incremented ONLY inside excavateEarliest → xfetch → stats.totalCalls.
    const writeProgress = (apiCalls: number): void => {
      db.prepare("UPDATE jobs SET api_calls = ? WHERE id = ?").run(apiCalls, jobId);
    };

    // 429 callback: persist resume_at before xfetch throws XApiStop("RATE_LIMIT").
    // The job will be suspended after excavateEarliest returns/throws.
    const onRateLimit = (resetEpochSec: number): void => {
      const resumeAt = new Date(resetEpochSec * 1000).toISOString();
      db.prepare("UPDATE jobs SET resume_at = ? WHERE id = ?").run(resumeAt, jobId);
      console.log(
        `[jobs] Job ${jobId} 429 — token_idx=${tokenIdx} reset_epoch=${resetEpochSec} resume_at=${resumeAt}`,
      );
    };

    let result: ExcavationResult | null = null;
    let rateLimitResumeAtMs: number | null = null;

    try {
      result = await excavateEarliest(
        username,
        limit,
        writeProgress,
        token,
        onRateLimit,
        saveCheckpoint,
        initialCheckpoint,
        jobId,
      );
    } catch (e: unknown) {
      // If xfetch threw XApiStop("RATE_LIMIT") and it wasn't caught inside
      // excavateEarliest, handle it here as a suspend (not a failure).
      if (e instanceof XApiStop && e.reason === "RATE_LIMIT") {
        const row = db
          .prepare("SELECT resume_at FROM jobs WHERE id = ?")
          .get(jobId) as { resume_at: string | null } | undefined;
        rateLimitResumeAtMs = row?.resume_at
          ? new Date(row.resume_at).getTime()
          : Date.now() + 60_000;
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        failJobInDb(jobId, "EXCAVATION_ERROR", msg, undefined, holdId);
        return; // finally handles cleanup
      }
    }

    // result.stopReason === "RATE_LIMIT" means excavateEarliest caught the
    // XApiStop internally and returned it as an errorResult — same treatment.
    if (result && result.stopReason === "RATE_LIMIT") {
      const row = db
        .prepare("SELECT resume_at FROM jobs WHERE id = ?")
        .get(jobId) as { resume_at: string | null } | undefined;
      rateLimitResumeAtMs = row?.resume_at
        ? new Date(row.resume_at).getTime()
        : Date.now() + 60_000;
      result = null; // treat as suspension, not failure
    }

    // ── Suspend path (429) ───────────────────────────────────────────────────
    if (rateLimitResumeAtMs !== null) {
      // Revert to QUEUED so the queue will re-launch after cooldown.
      db.prepare(
        "UPDATE jobs SET status = 'queued', resume_at = ? WHERE id = ?",
      ).run(new Date(rateLimitResumeAtMs).toISOString(), jobId);

      console.log(
        `[jobs] Job ${jobId} SUSPENDED token_idx=${tokenIdx} resume_at=${new Date(rateLimitResumeAtMs).toISOString()}`,
      );

      suspended = true;
      globalQueue.suspend(jobId, rateLimitResumeAtMs);
      return; // finally releases token; complete() is skipped via suspended flag
    }

    if (!result) {
      // Should not reach here, but guard anyway.
      failJobInDb(jobId, "INTERNAL_ERROR", "No result and no rate limit error");
      return; // finally handles cleanup
    }

    // ── Hard failure path ────────────────────────────────────────────────────
    const hardFailReasons = ["PROTECTED_OR_SUSPENDED_OR_NOT_FOUND", "API_ERROR"];
    if (hardFailReasons.includes(result.stopReason) && result.fetchedCount === 0) {
      failJobInDb(jobId, result.stopReason, `Stop reason: ${result.stopReason}`, result, holdId);
      return; // finally handles cleanup
    }

    // ── Guard: skip success if job was canceled while running ────────────────
    {
      const currentRow = db
        .prepare("SELECT status FROM jobs WHERE id = ?")
        .get(jobId) as { status: string } | undefined;
      if (currentRow?.status === "canceled") {
        console.log(
          `[jobs] Job ${jobId} was canceled while running — skipping success write, releasing hold`,
        );
        if (holdId) releaseHeld(holdId, "Job canceled while running");
        return; // finally handles token release and complete()
      }
    }

    // ── Success path ─────────────────────────────────────────────────────────
    if (holdId && result.fetchedCount > 0) {
      const captured = captureHeld(holdId, `Excavation success: ${result.fetchedCount} posts`);
      console.log(
        `[jobs] Credit ${captured ? "captured" : "capture failed"} for job ${jobId}`,
      );
    } else if (holdId && result.fetchedCount === 0) {
      const released = releaseHeld(holdId, "Excavation returned 0 posts");
      console.log(
        `[jobs] Credit ${released ? "released" : "release failed"} for job ${jobId} (0 posts)`,
      );
    }

    db.prepare(`
      UPDATE jobs
      SET status = 'succeeded',
          account_id = ?,
          api_calls = ?,
          fetched_count = ?,
          result_json = ?,
          resume_at = NULL,
          resume_state = NULL,
          finished_at = ?
      WHERE id = ?
    `).run(
      result.userId || null,
      result.apiCalls,
      result.fetchedCount,
      JSON.stringify(result),
      new Date().toISOString(),
      jobId,
    );

    if (result.userId && result.fetchedCount > 0) {
      db.prepare(`
        INSERT OR IGNORE INTO unlocks (user_id, account_id, job_id, unlocked_at)
        VALUES ('anonymous', ?, ?, ?)
      `).run(result.userId, jobId, new Date().toISOString());
    }

    console.log(
      `[jobs] Job ${jobId} SUCCEEDED token_idx=${tokenIdx}: ${result.fetchedCount} tweets, ${result.apiCalls} API calls`,
    );
    // fall through to finally

  } finally {
    // Always release the token and free the worker slot, regardless of how the
    // job exited. This ensures the next queued job can start even if an
    // unexpected exception was thrown mid-success or mid-failure.
    console.log(`[worker] released job=${jobId} token_idx=${tokenIdx}`);
    tokenPool.releaseToken(token);
    if (!suspended) {
      // Terminal exit (success / fail / cancel): apply soft cooldown so the
      // token isn't immediately recycled to the next job.
      // Skip on 429 suspend — hard cooldown (resume_at) handles that path.
      tokenPool.markUsed(token);
      // globalQueue.suspend() already manages the queue slot for the 429 path.
      // For every other exit (success, failure, abort) we must call complete().
      globalQueue.complete(jobId);
      console.log(`[queue] attempting to start next job`);
    }
  }
}

function failJobInDb(
  jobId: string,
  errorCode: string,
  errorMessage: string,
  result?: ExcavationResult,
  holdId?: string | null,
): void {
  const db = getDb();

  if (holdId) {
    const released = releaseHeld(holdId, `Job failed: ${errorCode}`);
    console.log(
      `[jobs] Credit ${released ? "released" : "release failed"} for failed job ${jobId}`,
    );
  }

  db.prepare(`
    UPDATE jobs
    SET status = 'failed',
        error_code = ?,
        error_message = ?,
        api_calls = ?,
        fetched_count = ?,
        result_json = ?,
        resume_at = NULL,
        resume_state = NULL,
        finished_at = ?
    WHERE id = ?
  `).run(
    errorCode,
    errorMessage,
    result?.apiCalls ?? 0,
    result?.fetchedCount ?? 0,
    result ? JSON.stringify(result) : null,
    new Date().toISOString(),
    jobId,
  );

  console.error(`[jobs] Job ${jobId} FAILED: ${errorCode} — ${errorMessage}`);
}
