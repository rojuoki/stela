/**
 * Stage Results Management - Phase 2
 * 
 * Account-level stage result storage and retrieval.
 * Implements immutable Stage 1 results that are reused instead of re-excavating.
 */

import { getDb } from "./db";
import type { ExcavationResult } from "./excavate";

export interface StageResult {
  id: number;
  account_id: string;
  stage: number;
  target_count: number;
  collected_count: number;
  status: string; // maps to ExcavationResult.stopReason
  job_id: string;
  created_at: string;
}

/**
 * Check if a stage result already exists for an account.
 * Returns the stored result if found, null otherwise.
 */
export function getStageResult(accountId: string, stage: number): StageResult | null {
  const db = getDb();
  const result = db
    .prepare(
      "SELECT * FROM stage_results WHERE account_id = ? AND stage = ?"
    )
    .get(accountId, stage) as StageResult | undefined;

  return result || null;
}

/**
 * Store a stage result after excavation completes.
 * This creates an immutable record for the account and stage.
 * 
 * @param accountId - The X account ID
 * @param stage - Stage number (1, 2, 3, etc.)
 * @param excavationResult - The completed excavation result
 * @param jobId - The job that created this result
 */
export function storeStageResult(
  accountId: string,
  stage: number,
  excavationResult: ExcavationResult,
  jobId: string
): void {
  const db = getDb();
  
  // Use INSERT OR IGNORE to handle race conditions gracefully.
  // If another job somehow stored a Stage 1 result for the same account
  // between our check and this insert, we respect the first one (immutability).
  const result = db
    .prepare(`
      INSERT OR IGNORE INTO stage_results 
      (account_id, stage, target_count, collected_count, status, job_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      accountId,
      stage,
      excavationResult.requestedLimit,
      excavationResult.fetchedCount,
      excavationResult.stopReason,
      jobId,
      new Date().toISOString()
    );

  if (result.changes === 0) {
    console.log(
      `[stage] Stage ${stage} result for account ${accountId} already exists - respecting immutability`
    );
  } else {
    console.log(
      `[stage] Stored Stage ${stage} result: account=${accountId} collected=${excavationResult.fetchedCount} target=${excavationResult.requestedLimit}`
    );
  }
}

/**
 * Create a synthetic ExcavationResult from a stored stage result.
 * Used to return cached results without re-excavating.
 */
export function createSyntheticExcavationResult(
  stageResult: StageResult,
  username: string,
  accountCreatedAt: string
): ExcavationResult {
  return {
    username,
    userId: stageResult.account_id,
    createdAt: accountCreatedAt,
    requestedLimit: stageResult.target_count,
    fetchedCount: stageResult.collected_count,
    stopReason: stageResult.status as any, // Trust the stored status
    apiCalls: 0, // No API calls made when reusing cached result
    storedNewCount: 0, // No new tweets stored when reusing cached result
    errors: [],
    acquisitionMode: "full_archive", // Assume full_archive (Stage 1 immutability implies successful past excavation)
  };
}