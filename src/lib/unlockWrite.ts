/**
 * STELA Unified Unlock Write — Phase 1 of boundary migration
 *
 * Single entry point for ALL unlock entitlement writes.
 * Computes `stage` mechanically from `boundary_end` for backward compatibility
 * with the existing multi-row schema. Phase 2 will drop `stage` from the schema.
 *
 * Key invariant: boundary_end NEVER decreases (enforced by GREATEST + WHERE).
 */

import { pgQuery } from "./db";

/**
 * Upsert an unlock entitlement for a user+account.
 *
 * - `stage` is derived as `Math.ceil(newBoundary / 100)` — callers must NOT
 *   pass a stage; it is an internal artifact of the current schema.
 * - Uses `GREATEST` to guarantee boundary_end never decreases.
 * - Replaces: recordStageUnlock, recordStageUnlockPg, recordUnlock, recordUnlockPg.
 *
 * @param userId     Authenticated user ID (or "anonymous")
 * @param accountId  X account ID
 * @param newBoundary  The new visible boundary (e.g. 100, 200, 300)
 * @param jobId      Job or label that caused this entitlement change
 */
export async function upsertUnlockBoundary(
  userId: string,
  accountId: string,
  newBoundary: number,
  jobId: string,
): Promise<void> {
  if (newBoundary <= 0) {
    console.warn(
      `[unlockWrite] Skipping upsert with non-positive boundary: userId=${userId} accountId=${accountId} boundary=${newBoundary}`,
    );
    return;
  }

  // Stage is a mechanical derivation for the current schema's UNIQUE constraint.
  // It will be removed in Phase 2 when the schema moves to UNIQUE(user_id, account_id).
  const stage = Math.ceil(newBoundary / 100);

  try {
    await pgQuery(
      `INSERT INTO unlocks (user_id, account_id, stage, boundary_end, granted_count, job_id, unlocked_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (user_id, account_id, stage) DO UPDATE SET
         boundary_end = GREATEST(unlocks.boundary_end, EXCLUDED.boundary_end),
         granted_count = EXCLUDED.granted_count,
         job_id = EXCLUDED.job_id,
         unlocked_at = EXCLUDED.unlocked_at
       WHERE EXCLUDED.boundary_end > unlocks.boundary_end`,
      [userId, accountId, stage, newBoundary, newBoundary, jobId],
    );
  } catch (error) {
    console.error("[unlockWrite] upsertUnlockBoundary error:", error);
    throw error;
  }
}
