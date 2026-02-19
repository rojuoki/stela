/**
 * STELA Job Runner — Phase 3 (with global serialization queue)
 *
 * Architecture:
 *   - Only ONE excavation job may run at a time (globalQueue enforces this).
 *   - New jobs start as QUEUED in DB; the queue transitions them to RUNNING when
 *     the slot is free.
 *   - On server restart, any jobs left in RUNNING are marked FAILED (SERVER_RESTART)
 *     and all QUEUED jobs are re-loaded into the in-memory queue.
 *
 * MANUAL TEST PLAN (global queue serialization):
 *   1. Start two unlocks for DIFFERENT usernames in quick succession.
 *   2. Server logs should show:
 *        [queue] Job <A> → RUNNING for @foo
 *        [queue] Job <B> → QUEUED (position 1) for @bar
 *   3. GET /api/jobs/<B>: status="queued", queuePosition=1, runningJobId=<A>
 *   4. No "[X API]" log lines for Job B while Job A is running.
 *   5. When Job A finishes → queue starts Job B automatically:
 *        [queue] Job <A> complete. Starting next: <B>
 *        [queue] Job <B> → RUNNING
 *   6. GET /api/jobs/<B>: status="running", queuePosition=null
 */

import { randomUUID } from "crypto";
import { getDb } from "./db";
import { excavateEarliest, type ExcavationResult } from "./excavate";
import { captureHeld, releaseHeld } from "./repository";

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
}

// ─── Global Serialization Queue ───────────────────────────────────────────────
//
// Ensures only ONE excavation job runs at a time.
// Others wait in FIFO order (insertion order into _pendingIds).
// `runJobAsync` is referenced here but defined below as a hoisted function
// declaration — this is intentional and works correctly in JS/TS.

class GlobalJobQueue {
  private _runningJobId: string | null = null;
  private _pendingIds: string[] = []; // FIFO waiting list

  constructor() {
    // Lazy-initialize on first use to avoid DB-not-ready issues at module load.
    // _init() is called explicitly from register() / complete() the first time.
  }

  private _initialized = false;

  private _ensureInit(): void {
    if (this._initialized) return;
    this._initialized = true;
    try {
      this._init();
    } catch (e) {
      console.warn("[queue] Init failed (will retry):", e instanceof Error ? e.message : e);
      this._initialized = false; // allow retry on next call
    }
  }

  // ── Public accessors ──────────────────────────────────────────────────────

  /** The job ID currently running X API calls, or null if idle. */
  get runningJobId(): string | null {
    return this._runningJobId;
  }

  /**
   * 1-based position in the waiting list. Returns null if the job is not
   * currently queued (either running, done, or unknown).
   */
  positionOf(jobId: string): number | null {
    const idx = this._pendingIds.indexOf(jobId);
    return idx === -1 ? null : idx + 1;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Register a newly-created job with the queue.
   * If the queue is idle, the job starts running immediately (DB updated to
   * RUNNING, excavation kicked off).
   * Otherwise the job stays QUEUED and waits in _pendingIds.
   */
  register(jobId: string): void {
    this._ensureInit();
    if (this._runningJobId === null) {
      this._launch(jobId);
    } else {
      this._pendingIds.push(jobId);
      console.log(`[queue] Job ${jobId} → QUEUED (position ${this._pendingIds.length})`);
    }
  }

  /**
   * Called when a job finishes (success OR failure).
   * Clears the running slot and starts the next pending job if any.
   */
  complete(jobId: string): void {
    if (this._runningJobId === jobId) {
      this._runningJobId = null;
    }
    // Defensive: remove from pending too (shouldn't be there, but be safe)
    this._pendingIds = this._pendingIds.filter((id) => id !== jobId);
    this._startNext();
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private _launch(jobId: string): void {
    this._runningJobId = jobId;

    // Transition job from QUEUED → RUNNING in DB.
    // For jobs that were already QUEUED and are now being promoted, this also
    // sets started_at so the UI can show when excavation actually started.
    try {
      const now = new Date().toISOString();
      getDb()
        .prepare("UPDATE jobs SET status = 'running', started_at = ? WHERE id = ?")
        .run(now, jobId);
      console.log(`[queue] Job ${jobId} → RUNNING`);
    } catch (e) {
      console.error(`[queue] Failed to mark job ${jobId} RUNNING in DB:`, e);
    }

    // runJobAsync is a hoisted function declaration defined below.
    runJobAsync(jobId).catch((e) => {
      console.error(`[queue] Unhandled error in job ${jobId}:`, e);
      this.complete(jobId);
    });
  }

  private _startNext(): void {
    if (this._runningJobId !== null || this._pendingIds.length === 0) return;
    const nextId = this._pendingIds.shift()!;
    console.log(`[queue] Job ${this._runningJobId ?? "(none)"} complete. Starting next: ${nextId}`);
    this._launch(nextId);
  }

  /**
   * Called once on first use. Recovers from server restarts:
   *   - Jobs left RUNNING → FAILED (SERVER_RESTART)
   *   - Jobs still QUEUED → loaded back into _pendingIds, first one auto-started
   */
  private _init(): void {
    const db = getDb();
    const now = new Date().toISOString();

    // Mark any interrupted RUNNING jobs as failed.
    const interrupted = db
      .prepare("SELECT id, hold_id FROM jobs WHERE status = 'running'")
      .all() as { id: string; hold_id: string | null }[];

    for (const job of interrupted) {
      if (job.hold_id) {
        try {
          releaseHeld(job.hold_id, "Server restart");
        } catch {}
      }
      db.prepare(`
        UPDATE jobs
        SET status = 'failed',
            error_code = 'SERVER_RESTART',
            error_message = 'Job interrupted by server restart',
            finished_at = ?
        WHERE id = ?
      `).run(now, job.id);
      console.log(`[queue] Job ${job.id} → FAILED (SERVER_RESTART)`);
    }

    // Re-load all QUEUED jobs in creation order so the FIFO contract is preserved.
    const queued = db
      .prepare("SELECT id FROM jobs WHERE status = 'queued' ORDER BY created_at ASC")
      .all() as { id: string }[];

    this._pendingIds = queued.map((j) => j.id);

    if (interrupted.length > 0 || this._pendingIds.length > 0) {
      console.log(
        `[queue] Init: ${interrupted.length} interrupted → FAILED, ` +
          `${this._pendingIds.length} queued job(s) loaded`,
      );
    }

    // Kick off the first queued job if any (server restarted mid-queue).
    this._startNext();
  }
}

/** Singleton queue — shared across all requests in the same Node.js process. */
export const globalQueue = new GlobalJobQueue();

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Create a new excavation job and register it with the global queue.
 *
 * The job is always inserted as QUEUED first; the queue immediately promotes it
 * to RUNNING (and starts excavation) if no other job is active, or leaves it
 * QUEUED otherwise.
 *
 * Returns the new job ID.
 */
export function createAndRunJob(
  username: string,
  limit: number = 100,
  holdId?: string,
): string {
  const db = getDb();
  const jobId = randomUUID();
  const now = new Date().toISOString();

  // Insert as QUEUED. The queue will transition to RUNNING via _launch().
  db.prepare(`
    INSERT INTO jobs (id, account_username, requested_limit, hold_id, status, created_at)
    VALUES (?, ?, ?, ?, 'queued', ?)
  `).run(jobId, username.toLowerCase(), Math.min(limit, 100), holdId ?? null, now);

  // Register with the global queue (may start immediately or wait).
  globalQueue.register(jobId);

  return jobId;
}

/**
 * Get a job record by ID. Read-only — never triggers any X API calls.
 */
export function getJob(jobId: string): JobRecord | undefined {
  const db = getDb();
  return db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as
    | JobRecord
    | undefined;
}

// ─── Internal job runner (function declaration — hoisted) ─────────────────────
//
// IMPORTANT: This must be a `function` declaration (not const/arrow) so it is
// hoisted to the top of the module scope and available when GlobalJobQueue
// methods call it during initialization.

async function runJobAsync(jobId: string): Promise<void> {
  const db = getDb();

  // Read job parameters from DB (don't trust caller args — DB is source of truth).
  const jobRow = db
    .prepare(
      "SELECT account_username, requested_limit, hold_id FROM jobs WHERE id = ?",
    )
    .get(jobId) as
    | { account_username: string; requested_limit: number; hold_id: string | null }
    | undefined;

  if (!jobRow) {
    console.warn(`[jobs] Job ${jobId} not found in DB — skipping`);
    globalQueue.complete(jobId);
    return;
  }

  const { account_username: username, requested_limit: limit, hold_id: holdId } = jobRow;

  // Write live api_calls to DB after each probe so the polling client can
  // display progress in real time.
  const writeProgress = (apiCalls: number): void => {
    db.prepare("UPDATE jobs SET api_calls = ? WHERE id = ?").run(apiCalls, jobId);
  };

  let result: ExcavationResult;
  try {
    result = await excavateEarliest(username, limit, writeProgress);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    failJobInDb(jobId, "EXCAVATION_ERROR", msg, undefined, holdId);
    globalQueue.complete(jobId);
    return;
  }

  // Check if excavation itself signalled a hard failure with no results.
  const hardFailReasons = [
    "PROTECTED_OR_SUSPENDED_OR_NOT_FOUND",
    "RATE_LIMIT",
    "API_ERROR",
  ];
  if (hardFailReasons.includes(result.stopReason) && result.fetchedCount === 0) {
    failJobInDb(
      jobId,
      result.stopReason,
      `Stop reason: ${result.stopReason}`,
      result,
      holdId,
    );
    globalQueue.complete(jobId);
    return;
  }

  // Credit settlement.
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

  // Record unlock history.
  if (result.userId && result.fetchedCount > 0) {
    db.prepare(`
      INSERT OR IGNORE INTO unlocks (user_id, account_id, job_id, unlocked_at)
      VALUES ('anonymous', ?, ?, ?)
    `).run(result.userId, jobId, new Date().toISOString());
  }

  console.log(
    `[jobs] Job ${jobId} SUCCEEDED: ${result.fetchedCount} tweets, ${result.apiCalls} API calls`,
  );

  globalQueue.complete(jobId);
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
