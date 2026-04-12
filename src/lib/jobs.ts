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
import { excavateEarliest, type ExcavationCheckpoint, type ExcavationResult } from "./excavate";
import { upsertUnlockBoundary } from "./unlockWrite";
import { 
  captureHeldPg, 
  releaseHeldPg, 
  getStageResultPg, 
  storeStageResultPg,
  StageResult,
  createJobPg,
  getJobPg,
  updateJobStatusPg,
  updateJobToRunningPg,
  cancelJobPg,
  getJobsForInitPg,
  getAccountByUsernamePg,
  getHoldByJobIdPg,
  getNewestCachedTweetTimestampPg,
  getCachedTweetCountPg,
  getUserBoundaryEndPg,
  setExtendCooldownAfterTimelineExhaustPg,
  upsertDiamondSnapshotPg,
  updateTemporaryUnlockPg,
  getTweetsByAccountUpToBoundaryPg,
} from "./repository";
import { tokenPool } from "./tokenPool";
import { XApiStop } from "./xclient";
// createSyntheticExcavationResult removed with stage reuse logic
import { computeTargetCount } from "./unlockPlanning";

/** Persisted inside jobs.resume_state next to ExcavationCheckpoint so 429 resume keeps Phase 8 parameters. */
const ADDITIONAL_EXCAVATION_TYPE = "additional_excavation" as const;

export interface AdditionalExcavationContext {
  type: typeof ADDITIONAL_EXCAVATION_TYPE;
  targetBoundary: number;
  missingCount: number;
  continuationStartTime: string;
  continuationBased?: boolean;
  created_at?: string;
}

function isAdditionalExcavationShape(obj: unknown): obj is Record<string, unknown> {
  if (!obj || typeof obj !== "object") return false;
  const o = obj as Record<string, unknown>;
  return (
    o.type === ADDITIONAL_EXCAVATION_TYPE &&
    typeof o.targetBoundary === "number" &&
    typeof o.missingCount === "number" &&
    typeof o.continuationStartTime === "string"
  );
}

function normalizeAdditionalExcavationContext(src: Record<string, unknown>): AdditionalExcavationContext {
  const ctx: AdditionalExcavationContext = {
    type: ADDITIONAL_EXCAVATION_TYPE,
    targetBoundary: Number(src.targetBoundary),
    missingCount: Number(src.missingCount),
    continuationStartTime: String(src.continuationStartTime),
  };
  if (src.continuationBased !== undefined) ctx.continuationBased = Boolean(src.continuationBased);
  if (src.created_at !== undefined) ctx.created_at = String(src.created_at);
  return ctx;
}

function stripAdditionalExcavationContext(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const { additional_excavation_context: _ctx, ...rest } = raw;
  return rest;
}

function logJobCheckpointResume(jobId: string, cp: ExcavationCheckpoint): void {
  console.log(
    `[jobs] Job ${jobId} resuming from checkpoint phase=${cp.phase}` +
      (cp.phase === "collect"
        ? ` window=${cp.collect_window_start?.slice(0, 10)} ids=${cp.collected_ids?.length ?? 0}`
        : cp.phase === "explore_month"
          ? ` year=${cp.month_scan_year} month=${cp.next_month}`
          : ` next_year=${cp.next_year}`),
  );
}

export interface JobRecord {
  id: string;
  account_username: string;
  account_id: string | null;
  user_id: string;
  requested_limit: number;
  /** Phase 4: Stage being excavated (1, 2, 3, etc.) - defaults to 1 for backward compatibility */
  stage: number;
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
  /** Force rerun flags by jobId (cleared after job completes). */
  private _forceFlags = new Map<string, boolean>();
  /** Lazy initialization flag to prevent multiple _init() calls. */
  private _initialized = false;

  constructor() {
    // Defer initialization until first use to avoid DB access during module evaluation
  }

  /** Ensure database initialization happens exactly once. */
  private async _ensureInitialized(): Promise<void> {
    if (!this._initialized) {
      try {
        await this._init();
        this._initialized = true;
      } catch (e) {
        console.warn(
          "[queue] Init skipped (DB not ready?):",
          e instanceof Error ? e.message : e,
        );
        // Don't set _initialized = true so we can retry later
        throw e;
      }
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
  async cancelJob(jobId: string): Promise<boolean> {
    // Ensure initialization before database access
    await this._ensureInitialized();
    
    const job = await getJobPg(jobId);

    if (!job) return false;
    if (["canceled", "succeeded", "failed"].includes(job.status)) return false;

    const isRunning = this._runningJobIds.has(jobId);

    // Release credit hold for non-running jobs (running jobs release in runJobAsync).
    if (!isRunning && job.hold_id) {
      await releaseHeldPg(job.hold_id, "Job canceled by user");
    }

    // Mark canceled in DB immediately.
    await updateJobStatusPg(jobId, 'canceled', {
      finished_at: new Date().toISOString(),
      resume_at: undefined,
      resume_state: undefined
    });

    // Remove from in-memory structures.
    this._pendingIds = this._pendingIds.filter((id) => id !== jobId);
    this._waitingIds.delete(jobId);
    // _runningJobIds is NOT removed here: runJobAsync still holds the slot and
    // will call complete() via finally when excavateEarliest finishes naturally.

    console.log(`[queue] Job ${jobId} CANCELED (was ${job.status})`);
    return true;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Register a newly-created job (always starts as QUEUED in DB).
   * Launches immediately if a slot and token are available.
   */
  register(jobId: string): void {
    // Ensure initialization before processing jobs
    this._ensureInitialized().catch(console.error);
    
    if (this._runningJobIds.size < tokenPool.M && tokenPool.hasAvailableToken()) {
      this._launch(jobId).catch((e) => {
        console.error(`[queue] Failed to launch job ${jobId}:`, e);
        this.complete(jobId);
      });
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
    this.clearForceFlag(jobId); // Clean up force flag
    this._startNext();
  }

  /** Set force flag for a job (admin rerun bypass) */
  setForceFlag(jobId: string, force: boolean): void {
    if (force) {
      this._forceFlags.set(jobId, true);
    } else {
      this._forceFlags.delete(jobId);
    }
  }

  /** Check if job has force flag set (bypass stage reuse) */
  hasForceFlag(jobId: string): boolean {
    return this._forceFlags.has(jobId);
  }

  /** Clear force flag when job completes */
  clearForceFlag(jobId: string): void {
    this._forceFlags.delete(jobId);
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
    setTimeout(() => this._tryResume(jobId).catch(console.error), delayMs);

    // Free up the slot so other pending jobs can proceed.
    this._startNext();
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private async _launch(jobId: string): Promise<void> {
    this._runningJobIds.add(jobId);
    
    try {
      await updateJobToRunningPg(jobId);
      console.log(
        `[queue] Job ${jobId} → RUNNING (${this._runningJobIds.size}/${tokenPool.M})`,
      );
    } catch (e) {
      console.error(`[queue] Failed to mark job ${jobId} RUNNING:`, e);
      // Remove from running set since DB update failed
      this._runningJobIds.delete(jobId);
      return;
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
      this._launch(nextId).catch((e) => {
        console.error(`[queue] Failed to launch job ${nextId}:`, e);
        this.complete(nextId);
      });
    }
  }

  /** Called by the resume timer; re-queues the job if the token is free. */
  private async _tryResume(jobId: string): Promise<void> {
    this._waitingIds.delete(jobId);

    // Verify job still exists and is still queued (user might have canceled it).
    const job = await getJobPg(jobId);

    if (!job || job.status !== "queued") {
      console.log(
        `[queue] Resume skip: job ${jobId} status=${job?.status ?? "not found"}`,
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
      setTimeout(() => this._tryResume(jobId).catch(console.error), delayMs);
    }
  }

  private async _init(): Promise<void> {
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
    const { runningJobs, queuedJobs } = await getJobsForInitPg();

    for (const job of runningJobs) {
      // Note: node_pid comparison logic would require adding node_pid to JobRecord
      // For now, treat all running jobs as needing re-queue
      
      // Re-queue from checkpoint
      await updateJobStatusPg(job.id, 'queued', {
        error_code: undefined,
        error_message: undefined,
        resume_at: undefined
      });
      console.log(`[queue] Job ${job.id} → RE-QUEUED (was running at init; will resume from checkpoint)`);
    }

    // Reload QUEUED jobs. Split them into "ready" vs "waiting" based on resume_at.
    for (const job of queuedJobs) {
      const resumeAtMs = job.resume_at ? new Date(job.resume_at).getTime() : 0;
      if (resumeAtMs > nowMs) {
        // Still in rate-limit cooldown — schedule timer to re-queue.
        this._waitingIds.set(job.id, resumeAtMs);
        const delayMs = Math.max(100, resumeAtMs - nowMs) + RESUME_BUFFER_MS;
        setTimeout(() => this._tryResume(job.id).catch(console.error), delayMs);
        console.log(
          `[queue] Job ${job.id} WAITING_RATE_LIMIT — resume timer set (${Math.ceil(delayMs / 1000)}s)`,
        );
      } else {
        this._pendingIds.push(job.id);
      }
    }

    if (runningJobs.length > 0 || queuedJobs.length > 0) {
      console.log(
        `[queue] Init: ${runningJobs.length} interrupted → RE-QUEUED, ` +
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
 * Create a new excavation job and hand it to the global queue (Postgres version).
 * Always inserted as QUEUED; the queue promotes it to RUNNING when a slot opens.
 * /api/jobs/:id polling NEVER calls this function.
 *
 * @param accountCreatedAt  ISO string from the accounts table (if already cached).
 *                          Used to compute the dynamic target count; defaults to 100
 *                          when the account is not yet in the local DB.
 * @param stage             Stage to excavate (1, 2, 3, etc.) - defaults to 1
 */
export async function createAndRunJob(
  username: string,
  accountCreatedAt?: string | null,
  holdId?: string,
  stage: number = 1,
  force: boolean = false,
  userId: string = "anonymous",
): Promise<string> {
  const jobId = randomUUID();
  
  // For Stage 1, use the normal target computation
  // For higher stages, we'll compute the target during execution based on previous stage
  const targetCount = stage === 1 ? computeTargetCount(accountCreatedAt) : 0; // Will be computed at execution time

  await createJobPg({
    id: jobId,
    account_username: username.toLowerCase(),
    user_id: userId,
    requested_limit: targetCount,
    stage,
    hold_id: holdId ?? null
  });

  // Set force flag for admin rerun bypass
  if (force) {
    globalQueue.setForceFlag(jobId, true);
    console.log(`[jobs] Force flag set for job ${jobId} (@${username} Stage ${stage}) - will bypass stage reuse`);
  }

  globalQueue.register(jobId);
  return jobId;
}

/* REMOVED: createStageExpansionJob — stage expansion replaced by boundary-based extend */

/**
 * Create additional excavation job for Phase 8.
 * Uses normal excavation engine with continuation-based approach.
 * This is the "excavate_more" execution mode implementation.
 */
export async function createAdditionalExcavationJob(
  username: string,
  targetBoundary: number,
  missingCount: number,
  userId: string = "anonymous",
): Promise<string | null> {
  // Check if account exists
  const account = await getAccountByUsernamePg(username);

  if (!account) {
    console.error(`[additional-excavation] Account not found for @${username}`);
    return null;
  }

  // Create job record first WITHOUT starting execution
  const jobId = randomUUID();
  const now = new Date().toISOString();
  
  // Calculate continuation point (start after newest cached tweet)
  const newestTweetTimestamp = await getNewestCachedTweetTimestampPg(account.account_id);
  
  // If no tweets cached, fall back to account creation (shouldn't happen for additional excavation)
  const continuationStartTime = newestTweetTimestamp || account.created_at;
  
  console.log(`[additional-excavation] Continuation point: ${continuationStartTime} (${newestTweetTimestamp ? 'from newest tweet' : 'from account creation'})`);
  
  // Prepare additional excavation metadata BEFORE job creation
  const additionalExcavationMetadata = {
    type: 'additional_excavation',
    targetBoundary,
    missingCount,
    continuationBased: true,
    continuationStartTime,
    created_at: now,
  };
  
  // Create job record with resume_state already set
  await createJobPg({
    id: jobId,
    account_username: username.toLowerCase(),
    user_id: userId,
    requested_limit: missingCount, // Use missingCount as limit
    stage: 1, // Always use Stage 1 to avoid stage expansion confusion
    hold_id: null // holdId will be set separately
  });
  
  // Update with resume_state
  await updateJobStatusPg(jobId, 'queued', {
    resume_state: JSON.stringify(additionalExcavationMetadata)
  });
  
  // NOW register with queue to start execution
  globalQueue.register(jobId);
  
  console.log(`[additional-excavation] Created job ${jobId} for @${username}: targetBoundary=${targetBoundary}, missing=${missingCount}`);
  return jobId;
}

/** Read-only job lookup. Never triggers X API calls. */
export async function getJob(jobId: string): Promise<JobRecord | undefined> {
  const job = await getJobPg(jobId);
  return job || undefined;
}

// ─── Internal job runner (hoisted function declaration) ───────────────────────
//
// Called ONLY from GlobalJobQueue._launch(). Never called from polling endpoints.

async function runJobAsync(jobId: string): Promise<void> {
  // Acquire a token — guaranteed available since queue checked before _launch().
  const token = tokenPool.acquireToken(jobId);
  if (!token) {
    console.error(`[jobs] No token for job ${jobId} — failing (pool exhausted)`);
    await failJobInDb(jobId, "NO_TOKEN", "No bearer token available in pool");
    globalQueue.complete(jobId);
    return;
  }
  const tokenIdx = tokenPool.getTokenIndex(token);

  // Track whether this job handed off to the suspend path.
  // globalQueue.suspend() manages the queue slot itself, so we must NOT also
  // call globalQueue.complete() in the finally block for that path.
  let suspended = false;

  try {
    const job = await getJobPg(jobId);

    if (!job) {
      console.warn(`[jobs] Job ${jobId} not found — skipping`);
      return; // finally handles cleanup
    }

    // Guard: verify the job is still RUNNING before doing any work.
    // With the globalThis singleton this should always pass, but if something
    // external changes the DB status between _launch() and here, abort cleanly
    // rather than running a duplicate excavation.
    if (job.status !== "running") {
      console.warn(
        `[jobs] Job ${jobId} status=${job.status} at launch time (expected running) — aborting`,
      );
      return; // finally handles cleanup
    }

    const { account_username: username, user_id: requestingUserId, requested_limit: limit, stage: jobStage, hold_id: holdId } = job;

    // ── Parse resume_state once (checkpoint ± additional_excavation_context) ─────
    let rawResume: Record<string, unknown> | null = null;
    if (job.resume_state) {
      try {
        rawResume = JSON.parse(job.resume_state) as Record<string, unknown>;
      } catch {
        console.warn(`[jobs] Job ${jobId} corrupt resume_state — starting fresh`);
        rawResume = null;
      }
    }

    let additionalContextPayload: AdditionalExcavationContext | null = null;
    let initialCheckpoint: ExcavationCheckpoint | null = null;

    if (rawResume) {
      const nested = rawResume.additional_excavation_context;
      if (nested && typeof nested === "object" && isAdditionalExcavationShape(nested)) {
        additionalContextPayload = normalizeAdditionalExcavationContext(
          nested as Record<string, unknown>,
        );
        const stripped = stripAdditionalExcavationContext(rawResume);
        if (stripped.phase !== undefined && typeof stripped.phase === "string") {
          initialCheckpoint = stripped as unknown as ExcavationCheckpoint;
          logJobCheckpointResume(jobId, initialCheckpoint);
        }
      } else if (isAdditionalExcavationShape(rawResume) && rawResume.phase === undefined) {
        // Legacy initial Phase 8 row (metadata only, before first checkpoint save)
        additionalContextPayload = normalizeAdditionalExcavationContext(rawResume);
      } else if (rawResume.phase !== undefined && typeof rawResume.phase === "string") {
        // Normal excavation checkpoint, or legacy Phase 8 checkpoint without nested context
        initialCheckpoint = rawResume as unknown as ExcavationCheckpoint;
        logJobCheckpointResume(jobId, initialCheckpoint);
      }
    }

    const isAdditionalExcavation = additionalContextPayload !== null;
    const missingCount = additionalContextPayload?.missingCount ?? limit;
    const additionalExcavationData: AdditionalExcavationContext | null = additionalContextPayload;

    if (isAdditionalExcavation && additionalExcavationData) {
      console.log(
        `[additional-excavation] @${username} IDENTIFIED: missing=${missingCount} targetBoundary=${additionalExcavationData.targetBoundary}`,
      );
    }

    // Persist checkpoint to DB at every safe boundary inside the excavation.
    // Merge additional_excavation_context so 429 resume keeps targetBoundary / missingCount / continuation.
    const saveCheckpoint = (cp: ExcavationCheckpoint): void => {
      const payload: Record<string, unknown> = additionalContextPayload
        ? {
            ...(cp as unknown as Record<string, unknown>),
            additional_excavation_context: additionalContextPayload,
          }
        : (cp as unknown as Record<string, unknown>);
      updateJobStatusPg(jobId, undefined, {
        resume_state: JSON.stringify(payload),
      }).catch(console.error);
    };

    // Progress: api_calls counter updated after every probe (display only).
    // Incremented ONLY inside excavateEarliest → xfetch → stats.totalCalls.
    const writeProgress = (apiCalls: number): void => {
      updateJobStatusPg(jobId, undefined, {
        api_calls: apiCalls
      }).catch(console.error);
    };

    // 429 callback: persist resume_at before xfetch throws XApiStop("RATE_LIMIT").
    // The job will be suspended after excavateEarliest returns/throws.
    const onRateLimit = (resetEpochSec: number): void => {
      const resumeAt = new Date(resetEpochSec * 1000).toISOString();
      updateJobStatusPg(jobId, undefined, {
        resume_at: resumeAt
      }).catch(console.error);
      console.log(
        `[jobs] Job ${jobId} 429 — token_idx=${tokenIdx} reset_epoch=${resetEpochSec} resume_at=${resumeAt}`,
      );
    };

    let result: ExcavationResult | null = null;
    let rateLimitResumeAtMs: number | null = null;

    // Check if this is a force rerun (admin bypass)
    const isForceRerun = globalQueue.hasForceFlag(jobId);
    
    // Get account info
    const existingAccount = await getAccountByUsernamePg(username);

    // Stage reuse removed: each user gets independent excavation for boundary-based unlocks

    // Only run excavation if we don't have a cached stage result
    let ranExcavationEngine = false;
    if (!result) {
      ranExcavationEngine = true;

      try {
        if (isAdditionalExcavation && additionalExcavationData) {
          // ── Additional Excavation: Normal engine with continuation ──
          if (!existingAccount) {
            throw new Error(`Account not found for additional excavation`);
          }

          console.log(
            `[additional-excavation] @${username} Using NORMAL excavation engine: missingCount=${missingCount}, continuationPoint=${additionalExcavationData.continuationStartTime}`
          );
          
          // Use normal excavation with continuation point and dynamic stop
          result = await excavateEarliest(
            username,
            limit, // Keep original limit for compatibility
            writeProgress,
            token,
            onRateLimit,
            saveCheckpoint,
            initialCheckpoint,
            jobId,
            additionalExcavationData.continuationStartTime, // Start from continuation point
            missingCount, // Pass missingCount as the actual stop target
          );
          
        } else if (jobStage === 1) {
          // ── Normal Stage 1 Excavation ──
          console.log(`[stage] Stage 1 normal excavation: limit=${limit}`);
          
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
        }
      } catch (e: unknown) {
        // If xfetch threw XApiStop("RATE_LIMIT") and it wasn't caught inside
        // excavateEarliest, handle it here as a suspend (not a failure).
        if (e instanceof XApiStop && e.reason === "RATE_LIMIT") {
          const job = await getJobPg(jobId);
          rateLimitResumeAtMs = job?.resume_at
            ? new Date(job.resume_at).getTime()
            : Date.now() + 60_000;
        } else {
          const msg = e instanceof Error ? e.message : String(e);
          await failJobInDb(jobId, "EXCAVATION_ERROR", msg);
          return; // finally handles cleanup
        }
      }
    }

    // result.stopReason === "RATE_LIMIT" means excavateEarliest caught the
    // XApiStop internally and returned it as an errorResult — same treatment.
    if (result && result.stopReason === "RATE_LIMIT") {
      const job = await getJobPg(jobId);
      rateLimitResumeAtMs = job?.resume_at
        ? new Date(job.resume_at).getTime()
        : Date.now() + 60_000;
      result = null; // treat as suspension, not failure
    }

    // ── Suspend path (429) ───────────────────────────────────────────────────
    if (rateLimitResumeAtMs !== null) {
      // Revert to QUEUED so the queue will re-launch after cooldown.
      await updateJobStatusPg(jobId, 'queued', {
        resume_at: new Date(rateLimitResumeAtMs).toISOString()
      });

      console.log(
        `[jobs] Job ${jobId} SUSPENDED token_idx=${tokenIdx} resume_at=${new Date(rateLimitResumeAtMs).toISOString()}`,
      );

      suspended = true;
      globalQueue.suspend(jobId, rateLimitResumeAtMs);
      return; // finally releases token; complete() is skipped via suspended flag
    }

    if (!result) {
      // Should not reach here, but guard anyway.
      await failJobInDb(jobId, "INTERNAL_ERROR", "No result and no rate limit error");
      return; // finally handles cleanup
    }

    // ── Hard failure path ────────────────────────────────────────────────────
    const hardFailReasons = ["PROTECTED_OR_SUSPENDED_OR_NOT_FOUND", "API_ERROR"];
    if (hardFailReasons.includes(result.stopReason) && result.fetchedCount === 0) {
      await failJobInDb(jobId, result.stopReason, `Stop reason: ${result.stopReason}`, result);
      return; // finally handles cleanup
    }

    // ── Guard: skip success if job was canceled while running ────────────────
    {
      const currentJob = await getJobPg(jobId);
      if (currentJob?.status === "canceled") {
        console.log(
          `[jobs] Job ${jobId} was canceled while running — skipping success write, releasing hold`,
        );
        // Use credit_holds.job_id as billing source of truth
        const cancelHold = await getHoldByJobIdPg(jobId);
        if (cancelHold) await releaseHeldPg(cancelHold.id, "Job canceled while running");
        return; // finally handles token release and complete()
      }
    }

    // ── Phase 4: Store stage result for successful excavations ──────────────
    // Only store stage result if:
    // 1. This was a real excavation (not a cached result reuse)
    // 2. We have a valid userId (account was found/created)
    // 3. We don't already have this stage for this account
    if (result.accountId && result.apiCalls > 0) {
      const existingStageResult = await getStageResultPg(result.accountId, jobStage);
      if (!existingStageResult) {
        await storeStageResultPg(result.accountId, jobStage, result, jobId);
      }
    }

    // ── Success path with proper billing source of truth ───────────────────────
    // Use credit_holds.job_id as canonical billing link instead of jobs.hold_id
    const hold = await getHoldByJobIdPg(jobId);

    if (result.accountId) {
      const previousBoundary = await getUserBoundaryEndPg(
        requestingUserId,
        result.accountId,
      );

      if (isAdditionalExcavation && additionalExcavationData) {
        // Phase 8: entitlement from cache totals — not gated on fetchedCount (timeline may be exhausted with 0 in-run fetch).
        const newCachedCount = await getCachedTweetCountPg(result.accountId);
        const targetCount = additionalExcavationData.targetBoundary;
        const finalBoundary = Math.min(targetCount, newCachedCount);
        const grantedCount = Math.max(0, finalBoundary - previousBoundary);

        console.log(
          `[additional-excavation] Phase 8 post-execution: timelineExhausted=${result.timelineExhausted === true}, ` +
            `storedNew=${result.storedNewCount}, fetchedCount=${result.fetchedCount}, newCachedCount=${newCachedCount}, ` +
            `previousBoundary=${previousBoundary}, targetCount=${targetCount}, finalBoundary=${finalBoundary}`,
        );

        if (finalBoundary > previousBoundary) {
          await upsertUnlockBoundary(
            requestingUserId,
            result.accountId,
            finalBoundary,
            "additional-excavation",
          );
        }

        (result as any).previousBoundary = previousBoundary;
        (result as any).finalBoundary = finalBoundary;
        (result as any).newCachedCount = newCachedCount;

        console.log(
          `[additional-excavation] Phase 8 unlock: user=${requestingUserId}, account=${result.accountId}, ` +
            `finalBoundary=${finalBoundary}, previousBoundary=${previousBoundary}, granted=${grantedCount}`,
        );
      } else {
        // Standard excavation: compute boundary from cache or fetchedCount
        const timelineExhausted =
          result.timelineExhausted === true &&
          result.stopReason === "ACCOUNT_HAS_LESS_THAN_LIMIT";

        let boundaryEnd: number;
        if (timelineExhausted) {
          const newCached = await getCachedTweetCountPg(result.accountId);
          boundaryEnd = Math.min(limit, newCached);
          console.log(
            `[jobs] Timeline exhausted — cache-based boundary: cached=${newCached}, limit=${limit}, boundaryEnd=${boundaryEnd}`,
          );
        } else {
          boundaryEnd = result.fetchedCount;
        }

        if (boundaryEnd > previousBoundary && boundaryEnd > 0) {
          await upsertUnlockBoundary(
            requestingUserId,
            result.accountId,
            boundaryEnd,
            jobId,
          );
          console.log(
            `[jobs] Recorded unlock: user=${requestingUserId}, account=${result.accountId}, boundary=${boundaryEnd}`,
          );
        }
      }

      if (hold) {
        const newVisible = await getUserBoundaryEndPg(requestingUserId, result.accountId);
        if (newVisible > previousBoundary) {
          const captured = await captureHeldPg(
            hold.id,
            `Excavation success: visible boundary ${previousBoundary} → ${newVisible}`,
          );
          console.log(`[jobs] Credit ${captured ? "captured" : "capture failed"} for job ${jobId}`);
        } else {
          const released = await releaseHeldPg(
            hold.id,
            "No visible boundary advance from this job",
          );
          console.log(`[jobs] Credit ${released ? "released" : "release failed"} for job ${jobId}`);
        }
      }
    }

    // Timeline exhausted: 24h extend cooldown for this user+account (logged-in only)
    if (
      result.timelineExhausted === true &&
      result.accountId &&
      requestingUserId !== "anonymous"
    ) {
      try {
        await setExtendCooldownAfterTimelineExhaustPg(
          requestingUserId,
          result.accountId,
        );
        console.log(
          `[jobs] Job ${jobId}: extend cooldown set 24h for user=${requestingUserId} account=${result.accountId} (timeline exhausted)`,
        );
      } catch (e) {
        console.error(
          `[jobs] Job ${jobId}: failed to set extend cooldown (non-fatal):`,
          e,
        );
      }
    }

    // 💎 snapshot (option A): overwrite when this job actually ran excavateEarliest (skip stage-reuse synthetic success).
    if (
      ranExcavationEngine &&
      result.accountId &&
      requestingUserId !== "anonymous"
    ) {
      try {
        await upsertDiamondSnapshotPg(
          requestingUserId,
          result.accountId,
          result.timelineExhausted === true,
        );
      } catch (e) {
        console.error(
          `[jobs] Job ${jobId}: failed to persist diamond snapshot (non-fatal):`,
          e,
        );
      }
    }

    // ── Update guest temporary unlocks with actual excavation results ──────────
    if (requestingUserId === "anonymous" && result.accountId) {
      try {
        // Get actual tweets to update temporary unlock
        const newCachedCount = await getCachedTweetCountPg(result.accountId);
        let actualTweets: any[] = [];
        
        // Determine boundary for guest access (same logic as boundary calculation)
        let guestBoundary: number;
        if (isAdditionalExcavation && additionalExcavationData) {
          guestBoundary = Math.min(additionalExcavationData.targetBoundary, newCachedCount);
        } else {
          const timelineExhausted = result.timelineExhausted === true && result.stopReason === "ACCOUNT_HAS_LESS_THAN_LIMIT";
          guestBoundary = timelineExhausted ? Math.min(limit, newCachedCount) : result.fetchedCount;
        }
        
        if (guestBoundary > 0) {
          actualTweets = await getTweetsByAccountUpToBoundaryPg(result.accountId, guestBoundary);
        }
        
        const updated = await updateTemporaryUnlockPg(jobId, result.accountId, actualTweets);
        if (updated) {
          console.log(`[guest-unlock] Updated temporary unlock for job ${jobId} with ${actualTweets.length} tweets (boundary=${guestBoundary})`);
        }
      } catch (e) {
        console.warn(`[guest-unlock] Failed to update temporary unlock for job ${jobId} (non-fatal):`, e);
      }
    }

    // Update DB with result (including boundary info for additional excavation)
    await updateJobStatusPg(jobId, 'succeeded', {
      api_calls: result.apiCalls,
      fetched_count: result.fetchedCount,
      result_json: JSON.stringify(result),
      resume_at: null,
      resume_state: null,
      finished_at: new Date().toISOString()
    });

    console.log(
      `[jobs] Job ${jobId} SUCCEEDED token_idx=${tokenIdx}: ${result.fetchedCount} tweets, ${result.apiCalls} API calls`,
    );
    // fall through to finally

  } finally {
    // Always release ALL tokens assigned to this job, regardless of how the
    // job exited. This prevents orphaned ASSIGNED tokens from blocking future operations.
    console.log(`[worker] released job=${jobId} token_idx=${tokenIdx}`);
    tokenPool.releaseTokensForJob(jobId);
    if (!suspended) {
      // Terminal exit (success / fail / cancel): apply soft cooldown so the
      // primary token isn't immediately recycled to the next job.
      // Skip on 429 suspend — hard cooldown (resume_at) handles that path.
      tokenPool.markUsed(token);
      // globalQueue.suspend() already manages the queue slot for the 429 path.
      // For every other exit (success, failure, abort) we must call complete().
      globalQueue.complete(jobId);
      console.log(`[queue] attempting to start next job`);
    }
  }
}

async function failJobInDb(
  jobId: string,
  errorCode: string,
  errorMessage: string,
  result?: ExcavationResult,
  holdId?: string | null,
): Promise<void> {
  // Use credit_holds.job_id as billing source of truth instead of holdId parameter
  const hold = await getHoldByJobIdPg(jobId);

  if (hold && hold.status === 'held') {
    const released = await releaseHeldPg(hold.id, `Job failed: ${errorCode}`);
    console.log(
      `[jobs] Credit ${released ? "released" : "release failed"} for failed job ${jobId}`,
    );
  }

  await updateJobStatusPg(jobId, 'failed', {
    error_code: errorCode,
    error_message: errorMessage,
    api_calls: result?.apiCalls ?? 0,
    fetched_count: result?.fetchedCount ?? 0,
    result_json: result ? JSON.stringify(result) : undefined,
    resume_at: undefined,
    resume_state: undefined,
    finished_at: new Date().toISOString()
  });

  console.error(`[jobs] Job ${jobId} FAILED: ${errorCode} — ${errorMessage}`);
}
