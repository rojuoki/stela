/**
 * Stage Results Management - Phase 4
 * 
 * Account-level stage result storage and retrieval.
 * Supports Stage 1 (initial), Stage 2 (+100), and Stage 3 (+100) excavations.
 * Implements immutable stage results that are reused instead of re-excavating.
 */

import { pgQuery } from "./db";
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
export async function getStageResult(accountId: string, stage: number): Promise<StageResult | null> {
  const result = await pgQuery(
    "SELECT * FROM stage_results WHERE account_id = $1 AND stage = $2",
    [accountId, stage]
  );

  if (result.rows.length === 0) return null;
  return result.rows[0] as StageResult;
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
export async function storeStageResult(
  accountId: string,
  stage: number,
  excavationResult: ExcavationResult,
  jobId: string
): Promise<void> {
  // Use INSERT ... ON CONFLICT to handle race conditions gracefully.
  // If another job somehow stored a Stage 1 result for the same account
  // between our check and this insert, we respect the first one (immutability).
  const result = await pgQuery(`
    INSERT INTO stage_results 
    (account_id, stage, target_count, collected_count, status, job_id, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (account_id, stage) DO NOTHING
  `, [
    accountId,
    stage,
    excavationResult.requestedLimit,
    excavationResult.fetchedCount,
    excavationResult.stopReason,
    jobId,
    new Date().toISOString()
  ]);

  if (result.rowCount === 0) {
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
    accountId: stageResult.account_id,
    createdAt: accountCreatedAt,
    requestedLimit: stageResult.target_count,
    fetchedCount: stageResult.collected_count,
    stopReason: stageResult.status as any, // Trust the stored status
    apiCalls: 0, // No API calls made when reusing cached result
    storedNewCount: 0, // No new tweets stored when reusing cached result
    errors: [],
    acquisitionMode: "full_archive", // Assume full_archive (Stage immutability implies successful past excavation)
  };
}

/**
 * Check if all prerequisite stages exist for the requested stage.
 * Returns null if prerequisites are met, or missing stage number if not.
 */
export async function checkStagePrerequisites(accountId: string, targetStage: number): Promise<number | null> {
  if (targetStage <= 1) return null; // Stage 1 has no prerequisites

  // Check that all stages 1 through (targetStage - 1) exist
  for (let stage = 1; stage < targetStage; stage++) {
    const result = await pgQuery(
      "SELECT 1 FROM stage_results WHERE account_id = $1 AND stage = $2", 
      [accountId, stage]
    );
    
    if (result.rows.length === 0) {
      return stage; // Return the missing prerequisite stage number
    }
  }
  
  return null; // All prerequisites satisfied
}

/**
 * Get the highest completed stage for an account.
 * Returns 0 if no stages completed.
 */
export async function getAccountHighestStage(accountId: string): Promise<number> {
  const result = await pgQuery(
    "SELECT MAX(stage) as max_stage FROM stage_results WHERE account_id = $1",
    [accountId]
  );
  
  if (result.rows.length === 0) return 0;
  return result.rows[0].max_stage ?? 0;
}

/**
 * Calculate the target count for a stage expansion.
 * Stage 2 = Stage 1 + 100, Stage 3 = Stage 2 + 100, etc.
 */
export function calculateStageTarget(baselineCount: number, targetStage: number): number {
  if (targetStage <= 1) return baselineCount;
  
  // Each stage beyond 1 adds 100 posts to the previous stage's collected count
  return baselineCount + (100 * (targetStage - 1));
}

/**
 * Get all stage results for an account, ordered by stage.
 * Used for stage expansion planning and UI display.
 */
export async function getAccountStageResults(accountId: string): Promise<StageResult[]> {
  const result = await pgQuery(
    "SELECT * FROM stage_results WHERE account_id = $1 ORDER BY stage ASC",
    [accountId]
  );
  return result.rows as StageResult[];
}