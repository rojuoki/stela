/**
 * STELA Job Runner — Phase 3
 * In-process async job execution. No external queue.
 * Creates job → runs excavation in background → writes result to DB.
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
}

/**
 * Create a queued job and kick off background execution.
 * Returns the job ID immediately.
 */
export function createAndRunJob(username: string, limit: number = 100, holdId?: string): string {
  const db = getDb();
  const jobId = randomUUID();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO jobs (id, account_username, requested_limit, hold_id, status, created_at)
    VALUES (?, ?, ?, ?, 'queued', ?)
  `).run(jobId, username.toLowerCase(), Math.min(limit, 100), holdId || null, now);

  // Fire and forget — runs in same process
  runJob(jobId, username, limit).catch((e) => {
    console.error(`[jobs] Unhandled error in job ${jobId}:`, e);
    failJob(jobId, "INTERNAL_ERROR", e instanceof Error ? e.message : String(e));
  });

  return jobId;
}

/**
 * Get a job by ID.
 */
export function getJob(jobId: string): JobRecord | undefined {
  const db = getDb();
  return db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as JobRecord | undefined;
}

// ─── Internal ──────────────────────────────────────────

async function runJob(jobId: string, username: string, limit: number): Promise<void> {
  const db = getDb();

  // Get hold_id from job record
  const job = db.prepare("SELECT hold_id FROM jobs WHERE id = ?").get(jobId) as { hold_id: string | null } | undefined;
  const holdId = job?.hold_id;

  // Transition: queued → running
  const updated = db.prepare(`
    UPDATE jobs SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'
  `).run(new Date().toISOString(), jobId);

  if (updated.changes === 0) {
    // Job was already picked up or canceled — skip
    console.warn(`[jobs] Job ${jobId} not in queued state, skipping`);
    return;
  }

  let result: ExcavationResult;
  try {
    result = await excavateEarliest(username, limit);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    failJob(jobId, "EXCAVATION_ERROR", msg, undefined, holdId);
    return;
  }

  // Check if excavation itself reported a failure
  const failReasons = [
    "PROTECTED_OR_SUSPENDED_OR_NOT_FOUND",
    "RATE_LIMIT",
    "API_ERROR",
  ];
  if (failReasons.includes(result.stopReason) && result.fetchedCount === 0) {
    failJob(jobId, result.stopReason, `Stop reason: ${result.stopReason}`, result, holdId);
    return;
  }

  // Success - capture credit if hold exists
  if (holdId && result.fetchedCount > 0) {
    const captured = captureHeld(holdId, `Excavation success: ${result.fetchedCount} posts`);
    console.log(`[jobs] Credit ${captured ? 'captured' : 'failed to capture'} for job ${jobId}`);
  } else if (holdId && result.fetchedCount === 0) {
    // 0 posts → release credit
    const released = releaseHeld(holdId, "Excavation returned 0 posts");
    console.log(`[jobs] Credit ${released ? 'released' : 'failed to release'} for job ${jobId} (0 posts)`);
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

  // Record unlock
  if (result.userId && result.fetchedCount > 0) {
    db.prepare(`
      INSERT OR IGNORE INTO unlocks (user_id, account_id, job_id, unlocked_at)
      VALUES ('anonymous', ?, ?, ?)
    `).run(result.userId, jobId, new Date().toISOString());
  }

  console.log(`[jobs] Job ${jobId} succeeded: ${result.fetchedCount} tweets, ${result.apiCalls} API calls`);
}

function failJob(
  jobId: string,
  errorCode: string,
  errorMessage: string,
  result?: ExcavationResult,
  holdId?: string | null,
): void {
  const db = getDb();

  // Release credit on failure
  if (holdId) {
    const released = releaseHeld(holdId, `Job failed: ${errorCode}`);
    console.log(`[jobs] Credit ${released ? 'released' : 'failed to release'} for failed job ${jobId}`);
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
  console.error(`[jobs] Job ${jobId} failed: ${errorCode} — ${errorMessage}`);
}
