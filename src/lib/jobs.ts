/**
 * STELA Job Runner — Phase 3 (global serialization queue + TokenPool)
 *
 * Architecture:
 *   - M = min(tokenCount, M_MAX=3) jobs may run in parallel.
 *   - Each job acquires one bearer token from TokenPool at start and holds it
 *     until completion; the token is released regardless of outcome.
 *   - On 429: the token enters cooldown AND the job's resume_at is saved to DB
 *     so the polling client can show WAITING_RATE_LIMIT state. The in-process
 *     xfetch wait continues normally — the job does NOT stop executing.
 *   - On server restart: RUNNING / WAITING_RATE_LIMIT (status=running) jobs are
 *     marked FAILED (SERVER_RESTART), QUEUED jobs are reloaded and resumed.
 *
 * MANUAL TEST PLAN (global queue + parallel):
 *   1. Set X_BEARER_TOKENS="t1,t2" (two tokens → M=2).
 *   2. Start three unlocks for different usernames in quick succession.
 *   3. Logs show: Job A → RUNNING, Job B → RUNNING, Job C → QUEUED (position 1)
 *   4. GET /api/jobs/<C>: status="queued", queuePosition=1
 *   5. When A or B finishes → C starts automatically.
 *   6. 429 test: GET /api/jobs/<running>: status="waiting_rate_limit", resumeAt set.
 */

import { randomUUID } from "crypto";
import { getDb } from "./db";
import { excavateEarliest, type ExcavationResult } from "./excavate";
import { captureHeld, releaseHeld } from "./repository";
import { tokenPool } from "./tokenPool";

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
  /** Set when a 429 is received mid-job; cleared on completion. ISO-8601. */
  resume_at: string | null;
}

// ─── Global Serialization Queue ───────────────────────────────────────────────
//
// Allows up to M jobs to run concurrently (M = tokenPool.M).
// Excess requests wait in FIFO order in _pendingIds.

class GlobalJobQueue {
  /** Jobs currently executing excavation (≤ M). */
  private _runningJobIds = new Set<string>();
  /** FIFO list of job IDs waiting to be started. */
  private _pendingIds: string[] = [];

  private _initialized = false;

  private _ensureInit(): void {
    if (this._initialized) return;
    this._initialized = true;
    try {
      this._init();
    } catch (e) {
      console.warn("[queue] Init failed (will retry):", e instanceof Error ? e.message : e);
      this._initialized = false;
    }
  }

  // ── Public accessors ──────────────────────────────────────────────────────

  /** First running job ID, or null (for API backward-compat). */
  get runningJobId(): string | null {
    const it = this._runningJobIds.values().next();
    return it.done ? null : it.value;
  }

  /** All currently running job IDs. */
  get runningJobIds(): string[] {
    return [...this._runningJobIds];
  }

  /** 1-based queue position of a waiting job; null if not in the waiting list. */
  positionOf(jobId: string): number | null {
    const idx = this._pendingIds.indexOf(jobId);
    return idx === -1 ? null : idx + 1;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Register a newly-created job.
   * Starts it immediately if a slot and token are available; otherwise queues it.
   */
  register(jobId: string): void {
    this._ensureInit();
    if (this._runningJobIds.size < tokenPool.M && tokenPool.hasAvailableToken()) {
      this._launch(jobId);
    } else {
      this._pendingIds.push(jobId);
      console.log(`[queue] Job ${jobId} → QUEUED (position ${this._pendingIds.length})`);
    }
  }

  /**
   * Called when a job finishes (success OR failure).
   * Releases the running slot and starts the next pending job if possible.
   */
  complete(jobId: string): void {
    this._runningJobIds.delete(jobId);
    this._pendingIds = this._pendingIds.filter((id) => id !== jobId);
    this._startNext();
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private _launch(jobId: string): void {
    this._runningJobIds.add(jobId);
    try {
      const now = new Date().toISOString();
      getDb()
        .prepare("UPDATE jobs SET status = 'running', started_at = ? WHERE id = ?")
        .run(now, jobId);
      console.log(
        `[queue] Job ${jobId} → RUNNING (${this._runningJobIds.size}/${tokenPool.M})`,
      );
    } catch (e) {
      console.error(`[queue] Failed to mark job ${jobId} RUNNING in DB:`, e);
    }

    // runJobAsync is a hoisted function declaration — available here at runtime.
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
      console.log(`[queue] Starting next pending job: ${nextId}`);
      this._launch(nextId);
    }

    // If pending jobs exist but all tokens are in cooldown, schedule a retry
    // for when the earliest cooldown expires.
    if (this._pendingIds.length > 0 && !tokenPool.hasAvailableToken()) {
      const cooldownEnd = tokenPool.earliestCooldownEnd();
      if (cooldownEnd > 0) {
        const delayMs = Math.max(100, cooldownEnd - Date.now()) + 500;
        console.log(
          `[queue] All tokens in cooldown. Retrying pending jobs in ${Math.ceil(delayMs / 1000)}s`,
        );
        setTimeout(() => this._startNext(), delayMs);
      }
    }
  }

  private _init(): void {
    const db = getDb();
    const now = new Date().toISOString();

    // Mark any jobs left RUNNING (including those waiting on rate limits) as FAILED.
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
            resume_at = NULL,
            finished_at = ?
        WHERE id = ?
      `).run(now, job.id);
      console.log(`[queue] Job ${job.id} → FAILED (SERVER_RESTART)`);
    }

    // Re-load QUEUED jobs in creation order (FIFO).
    const queued = db
      .prepare("SELECT id FROM jobs WHERE status = 'queued' ORDER BY created_at ASC")
      .all() as { id: string }[];

    this._pendingIds = queued.map((j) => j.id);

    if (interrupted.length > 0 || this._pendingIds.length > 0) {
      console.log(
        `[queue] Init: ${interrupted.length} interrupted → FAILED, ` +
          `${this._pendingIds.length} queued job(s) loaded, M=${tokenPool.M}`,
      );
    }

    this._startNext();
  }
}

export const globalQueue = new GlobalJobQueue();

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Create a new excavation job and register it with the global queue.
 * Always inserted as QUEUED; the queue promotes it to RUNNING when a slot opens.
 */
export function createAndRunJob(
  username: string,
  limit: number = 100,
  holdId?: string,
): string {
  const db = getDb();
  const jobId = randomUUID();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO jobs (id, account_username, requested_limit, hold_id, status, created_at)
    VALUES (?, ?, ?, ?, 'queued', ?)
  `).run(jobId, username.toLowerCase(), Math.min(limit, 100), holdId ?? null, now);

  globalQueue.register(jobId);

  return jobId;
}

/** Get a job record by ID. Read-only — never triggers any X API calls. */
export function getJob(jobId: string): JobRecord | undefined {
  const db = getDb();
  return db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as
    | JobRecord
    | undefined;
}

// ─── Internal job runner (function declaration — hoisted) ─────────────────────

async function runJobAsync(jobId: string): Promise<void> {
  const db = getDb();

  // Acquire a token from the pool (guaranteed available — queue checked before launch).
  const token = tokenPool.acquireToken(jobId);
  if (!token) {
    // Safety net: should not happen under normal operation.
    console.error(`[jobs] No token available for job ${jobId} — failing immediately`);
    failJobInDb(jobId, "NO_TOKEN", "No bearer token available in pool");
    globalQueue.complete(jobId);
    return;
  }

  const jobRow = db
    .prepare("SELECT account_username, requested_limit, hold_id FROM jobs WHERE id = ?")
    .get(jobId) as
    | { account_username: string; requested_limit: number; hold_id: string | null }
    | undefined;

  if (!jobRow) {
    console.warn(`[jobs] Job ${jobId} not found in DB — skipping`);
    tokenPool.releaseToken(token);
    globalQueue.complete(jobId);
    return;
  }

  const { account_username: username, requested_limit: limit, hold_id: holdId } = jobRow;

  // Live API call progress → DB.
  const writeProgress = (apiCalls: number): void => {
    db.prepare("UPDATE jobs SET api_calls = ? WHERE id = ?").run(apiCalls, jobId);
  };

  // 429 callback: mark job as WAITING_RATE_LIMIT in DB (resume_at = reset time).
  // The in-process xfetch wait continues; this is purely for observability.
  const onRateLimit = (resetEpochSec: number): void => {
    const resumeAt = new Date(resetEpochSec * 1000).toISOString();
    db.prepare("UPDATE jobs SET resume_at = ? WHERE id = ?").run(resumeAt, jobId);
    console.log(`[jobs] Job ${jobId} WAITING_RATE_LIMIT until ${resumeAt}`);
  };

  let result: ExcavationResult;
  try {
    result = await excavateEarliest(username, limit, writeProgress, token, onRateLimit);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    failJobInDb(jobId, "EXCAVATION_ERROR", msg, undefined, holdId);
    tokenPool.releaseToken(token);
    globalQueue.complete(jobId);
    return;
  }

  const hardFailReasons = [
    "PROTECTED_OR_SUSPENDED_OR_NOT_FOUND",
    "RATE_LIMIT",
    "API_ERROR",
  ];
  if (hardFailReasons.includes(result.stopReason) && result.fetchedCount === 0) {
    failJobInDb(jobId, result.stopReason, `Stop reason: ${result.stopReason}`, result, holdId);
    tokenPool.releaseToken(token);
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
        resume_at = NULL,
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
    `[jobs] Job ${jobId} SUCCEEDED: ${result.fetchedCount} tweets, ${result.apiCalls} API calls`,
  );

  tokenPool.releaseToken(token);
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
        resume_at = NULL,
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
