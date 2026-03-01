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
import { logger, generateTraceId, getTokenFingerprint } from './logger';

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
      const error = e instanceof Error ? e : new Error(String(e));
      logger.warn({
        trace_id: generateTraceId(),
        job_id: null,
        service: 'lib',
        event: 'job_failed', // System initialization failure
        error_code: 'DB_INIT_FAILED',
        err_name: error.constructor.name,
        err_message: error.message,
      }, "Job queue init skipped - DB not ready");
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

    logger.info({
      trace_id: jobId, // Use jobId as trace_id
      job_id: jobId,
      service: 'lib',
      event: 'job_failed',
      previous_status: row.status,
      error_code: 'CANCELED_BY_USER',
    }, `Job ${jobId} canceled by user (was ${row.status})`);
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
      logger.info({
        trace_id: jobId, // Use jobId as trace_id
        job_id: jobId,
        service: 'lib',
        event: 'job_created',
        queue_position: this._pendingIds.length,
        queue_status: 'pending',
      }, `Job ${jobId} queued at position ${this._pendingIds.length}`);
    }
  }

  /**
   * Called when a job finishes (success OR non-rate-limit failure).
   * Clears the running slot and promotes the next pending job.
   */
  complete(jobId: string): void {
    // Check job status from DB to determine success/failure
    const row = getDb()
      .prepare("SELECT status FROM jobs WHERE id = ?")
      .get(jobId) as { status: string } | undefined;

    if (row) {
      const isSuccess = row.status === 'succeeded';
      logger.info({
        trace_id: jobId, // Use jobId as trace_id  
        job_id: jobId,
        service: 'lib',
        event: isSuccess ? 'job_succeeded' : 'job_failed',
        final_status: row.status,
      }, `Job ${jobId} completed with status ${row.status}`);
    }

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
    
    logger.warn({
      trace_id: jobId, // Use jobId as trace_id
      job_id: jobId,
      service: 'lib',
      event: 'job_suspended',
      resume_at_ms: resumeAtMs,
      delay_seconds: Math.ceil(delayMs / 1000),
      error_code: 'RATE_LIMIT',
    }, `Job ${jobId} suspended due to rate limit, resuming in ${Math.ceil(delayMs / 1000)}s`);
    
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
      logger.info({
        trace_id: jobId, // Use jobId as trace_id
        job_id: jobId,
        service: 'lib',
        event: 'job_started',
        running_jobs: this._runningJobIds.size,
        max_concurrent: tokenPool.M,
      }, `Job ${jobId} started running (${this._runningJobIds.size}/${tokenPool.M})`);
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      logger.error({
        trace_id: jobId,
        job_id: jobId,
        service: 'lib',
        event: 'job_failed',
        error_code: 'DB_UPDATE_FAILED',
        err_name: error.constructor.name,
        err_message: error.message,
      }, `Failed to mark job ${jobId} as running`);
    }

    // runJobAsync is a hoisted function declaration.
    runJobAsync(jobId).catch((e) => {
      const error = e instanceof Error ? e : new Error(String(e));
      logger.error({
        trace_id: jobId,
        job_id: jobId,
        service: 'lib',
        event: 'job_failed',
        error_code: 'UNHANDLED_ERROR',
        err_name: error.constructor.name,
        err_message: error.message,
        err_stack: error.stack,
      }, `Unhandled error in job ${jobId}`);
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
      logger.info({
        trace_id: nextId,
        job_id: nextId,
        service: 'lib',
        event: 'job_created', // Next job being launched
        queue_position: 0, // Now at front
      }, `Starting next job: ${nextId}`);
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
      logger.warn({
        trace_id: jobId,
        job_id: jobId,
        service: 'lib',
        event: 'job_failed',
        current_status: row?.status ?? 'not_found',
        error_code: 'RESUME_INVALID_STATUS',
      }, `Resume skipped: job ${jobId} status=${row?.status ?? "not found"}`);
      return;
    }

    if (tokenPool.hasAvailableToken()) {
      logger.info({
        trace_id: jobId,
        job_id: jobId,
        service: 'lib',
        event: 'job_resumed',
      }, `Job ${jobId} resumed - re-queued with priority`);
      // Push to front so a resumed job has priority over brand-new ones.
      this._pendingIds.unshift(jobId);
      this._startNext();
    } else {
      // Token still in cooldown — reschedule.
      const nextEnd = tokenPool.earliestCooldownEnd();
      const delayMs = nextEnd > 0 ? Math.max(100, nextEnd - Date.now()) + RESUME_BUFFER_MS : 60_000;
      
      logger.warn({
        trace_id: jobId,
        job_id: jobId,
        service: 'lib',
        event: 'job_suspended', // Still suspended, rescheduling
        delay_seconds: Math.ceil(delayMs / 1000),
        error_code: 'TOKEN_STILL_COOLING',
      }, `Job ${jobId} resume delayed - token still in cooldown, retrying in ${Math.ceil(delayMs / 1000)}s`);
      
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
        logger.info({
          trace_id: job.id,
          job_id: job.id,
          service: 'lib',
          event: 'job_started', // Still running
          pid: process.pid,
          recovery_type: 'HMR_GUARD',
        }, `Job ${job.id} still running in PID ${process.pid} - HMR guard, not re-queuing`);
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
      logger.info({
        trace_id: job.id,
        job_id: job.id,
        service: 'lib',
        event: 'job_resumed', // Re-queued to resume from checkpoint
        recovery_type: 'RESTART_RECOVERY',
      }, `Job ${job.id} re-queued after restart - will resume from checkpoint`);
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
        logger.info({
          trace_id: job.id,
          job_id: job.id,
          service: 'lib',
          event: 'job_suspended', // Waiting for rate limit
          delay_seconds: Math.ceil(delayMs / 1000),
          resume_at_ms: resumeAtMs,
          error_code: 'RATE_LIMIT',
        }, `Job ${job.id} waiting for rate limit - resume timer set (${Math.ceil(delayMs / 1000)}s)`);
      } else {
        this._pendingIds.push(job.id);
      }
    }

    if (interrupted.length > 0 || queued.length > 0) {
      logger.info({
        trace_id: generateTraceId(), // System initialization
        job_id: null,
        service: 'lib',
        event: 'job_created', // System startup with job recovery
        interrupted_count: interrupted.length,
        pending_count: this._pendingIds.length,
        waiting_count: this._waitingIds.size,
        max_concurrent: tokenPool.M,
        recovery_type: 'SYSTEM_INIT',
      }, `Job queue initialized: ${interrupted.length} interrupted → re-queued, ${this._pendingIds.length} pending, ${this._waitingIds.size} waiting`);
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
  traceId?: string,
): string {
  const db = getDb();
  const jobId = randomUUID();
  const now = new Date().toISOString();
  const targetCount = computeTargetCount(accountCreatedAt);

  db.prepare(`
    INSERT INTO jobs (id, account_username, requested_limit, hold_id, status, created_at, trace_id)
    VALUES (?, ?, ?, ?, 'queued', ?, ?)
  `).run(jobId, username.toLowerCase(), targetCount, holdId ?? null, now, traceId || jobId);

  logger.info({
    trace_id: traceId || jobId, // Use provided traceId or fallback to jobId
    job_id: jobId,
    service: 'lib',
    event: 'job_created',
    username: username.toLowerCase(),
    requested_limit: targetCount,
    hold_id: holdId || null,
  }, `Job created: ${jobId} for @${username} (limit: ${targetCount})`);

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
    // Note: We don't have traceId at this point since the job fetch failed
    logger.error({
      trace_id: jobId, // Fallback to jobId
      job_id: jobId,
      service: 'lib',
      event: 'job_failed',
      error_code: 'NO_TOKEN',
    }, `No token available for job ${jobId} - pool exhausted`);
    failJobInDb(jobId, "NO_TOKEN", "No bearer token available in pool");
    globalQueue.complete(jobId);
    return;
  }
  const tokenIdx = tokenPool.getTokenIndex(token);

  // Get trace_id early for consistent logging
  let effectiveTraceId = jobId; // Default fallback
  try {
    const traceQuery = db
      .prepare("SELECT trace_id FROM jobs WHERE id = ?")
      .get(jobId) as { trace_id: string | null } | undefined;
    if (traceQuery?.trace_id) {
      effectiveTraceId = traceQuery.trace_id;
    }
  } catch {
    // Continue with jobId as traceId
  }

  // Track whether this job handed off to the suspend path.
  // globalQueue.suspend() manages the queue slot itself, so we must NOT also
  // call globalQueue.complete() in the finally block for that path.
  let suspended = false;

  try {
    const jobRow = db
      .prepare("SELECT account_username, requested_limit, hold_id, resume_state, status, trace_id FROM jobs WHERE id = ?")
      .get(jobId) as
      | { account_username: string; requested_limit: number; hold_id: string | null; resume_state: string | null; status: string; trace_id: string | null }
      | undefined;

    if (!jobRow) {
      logger.warn({
        trace_id: effectiveTraceId,
        job_id: jobId,
        service: 'lib',
        event: 'job_failed',
        error_code: 'JOB_NOT_FOUND',
      }, `Job ${jobId} not found in database - skipping`);
      return; // finally handles cleanup
    }

    // Guard: verify the job is still RUNNING before doing any work.
    // With the globalThis singleton this should always pass, but if something
    // external changes the DB status between _launch() and here, abort cleanly
    // rather than running a duplicate excavation.
    if (jobRow.status !== "running") {
      logger.warn({
        trace_id: effectiveTraceId,
        job_id: jobId,
        service: 'lib',
        event: 'job_failed',
        error_code: 'INVALID_STATUS',
        expected_status: 'running',
        actual_status: jobRow.status,
      }, `Job ${jobId} has unexpected status ${jobRow.status} at launch time - aborting`);
      return; // finally handles cleanup
    }

    const { account_username: username, requested_limit: limit, hold_id: holdId } = jobRow;
    // effectiveTraceId already set from earlier query

    // Restore checkpoint from previous run (if any).
    let initialCheckpoint: ExcavationCheckpoint | null = null;
    if (jobRow.resume_state) {
      try {
        initialCheckpoint = JSON.parse(jobRow.resume_state) as ExcavationCheckpoint;
        logger.info({
          trace_id: effectiveTraceId,
          job_id: jobId,
          service: 'lib',
          event: 'job_resumed',
          checkpoint_phase: initialCheckpoint.phase,
          binsearch_lo: initialCheckpoint.phase === "binsearch" ? initialCheckpoint.binsearch_lo.slice(0, 10) : undefined,
          binsearch_hi: initialCheckpoint.phase === "binsearch" ? initialCheckpoint.binsearch_hi.slice(0, 10) : undefined,
        }, `Job ${jobId} resuming from checkpoint phase=${initialCheckpoint.phase}`);
      } catch {
        logger.warn({
          trace_id: effectiveTraceId,
          job_id: jobId,
          service: 'lib',
          event: 'job_started', // Starting fresh after corruption
          error_code: 'CORRUPT_RESUME_STATE',
        }, `Job ${jobId} corrupt resume_state - starting fresh`);
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
      logger.warn({
        trace_id: jobId,
        job_id: jobId,
        service: 'lib',
        event: 'x_429',
        token_idx: tokenIdx,
        token_fp: getTokenFingerprint(token),
        rate_reset: resetEpochSec,
        resume_at: resumeAt,
        error_code: 'RATE_LIMIT',
      }, `Job ${jobId} hit 429 rate limit - will resume at ${resumeAt}`);
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
        effectiveTraceId,
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

      logger.warn({
        trace_id: jobId,
        job_id: jobId,
        service: 'lib',
        event: 'job_suspended',
        token_idx: tokenIdx,
        token_fp: getTokenFingerprint(token),
        resume_at_ms: rateLimitResumeAtMs,
        error_code: 'RATE_LIMIT',
      }, `Job ${jobId} suspended due to rate limit - resume at ${new Date(rateLimitResumeAtMs).toISOString()}`);

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
        logger.info({
          trace_id: jobId,
          job_id: jobId,
          service: 'lib',
          event: 'job_failed',
          error_code: 'CANCELED_DURING_RUN',
          hold_id: holdId || null,
        }, `Job ${jobId} was canceled while running - skipping success write, releasing hold`);
        if (holdId) releaseHeld(holdId, "Job canceled while running");
        return; // finally handles token release and complete()
      }
    }

    // ── Success path ─────────────────────────────────────────────────────────
    if (holdId && result.fetchedCount > 0) {
      const captured = captureHeld(holdId, `Excavation success: ${result.fetchedCount} posts`);
      logger.info({
        trace_id: jobId,
        job_id: jobId,
        service: 'lib',
        event: 'job_succeeded',
        hold_id: holdId,
        credit_captured: captured,
        fetched_count: result.fetchedCount,
      }, `Credit ${captured ? "captured" : "capture failed"} for job ${jobId}`);
    } else if (holdId && result.fetchedCount === 0) {
      const released = releaseHeld(holdId, "Excavation returned 0 posts");
      logger.info({
        trace_id: jobId,
        job_id: jobId,
        service: 'lib',
        event: 'job_succeeded',
        hold_id: holdId,
        credit_released: released,
        fetched_count: 0,
      }, `Credit ${released ? "released" : "release failed"} for job ${jobId} (0 posts)`);
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

    logger.info({
      trace_id: jobId,
      job_id: jobId,
      service: 'lib',
      event: 'job_succeeded',
      token_idx: tokenIdx,
      token_fp: getTokenFingerprint(token),
      fetched_count: result.fetchedCount,
      api_calls: result.apiCalls,
      user_id: result.userId || null,
    }, `Job ${jobId} completed successfully: ${result.fetchedCount} tweets, ${result.apiCalls} API calls`);
    // fall through to finally

  } finally {
    // Always release the token and free the worker slot, regardless of how the
    // job exited. This ensures the next queued job can start even if an
    // unexpected exception was thrown mid-success or mid-failure.
    logger.info({
      trace_id: jobId,
      job_id: jobId,
      service: 'lib',
      event: 'token_released',
      token_idx: tokenIdx,
      token_fp: getTokenFingerprint(token),
      suspended: suspended,
    }, `Released token for job ${jobId}`);
    
    tokenPool.releaseToken(token);
    if (!suspended) {
      // Terminal exit (success / fail / cancel): apply soft cooldown so the
      // token isn't immediately recycled to the next job.
      // Skip on 429 suspend — hard cooldown (resume_at) handles that path.
      tokenPool.markUsed(token);
      // globalQueue.suspend() already manages the queue slot for the 429 path.
      // For every other exit (success, failure, abort) we must call complete().
      globalQueue.complete(jobId);
      
      logger.debug({
        trace_id: jobId,
        job_id: jobId,
        service: 'lib',
        event: 'job_succeeded', // Flow control - attempting next
      }, `Attempting to start next queued job`);
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
    logger.info({
      trace_id: jobId,
      job_id: jobId,
      service: 'lib',
      event: 'job_failed',
      hold_id: holdId,
      credit_released: released,
      error_code: errorCode,
    }, `Credit ${released ? "released" : "release failed"} for failed job ${jobId}`);
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

  logger.error({
    trace_id: jobId,
    job_id: jobId,
    service: 'lib',
    event: 'job_failed',
    error_code: errorCode,
    error_message: errorMessage,
    api_calls: result?.apiCalls ?? 0,
    fetched_count: result?.fetchedCount ?? 0,
  }, `Job ${jobId} failed: ${errorCode} - ${errorMessage}`);
}
