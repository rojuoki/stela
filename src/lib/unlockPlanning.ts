/**
 * STELA Unlock Planning - Centralized boundary logic
 * 
 * This module owns ALL planning logic for unlock operations:
 * - Current unlocked boundary calculation (user-specific)
 * - Next target boundary determination (+100)
 * - Account cached total retrieval
 * - Missing remainder calculation
 * - Cache vs excavation decision
 * - Excavation continuation start point
 * 
 * CRITICAL RULES:
 * - account_cached_total → ONLY for planning
 * - user_unlocked_boundary → ONLY for UI rendering
 * - NO stage arithmetic in other modules
 * - NO mixing of cached total with unlocked boundary
 * - Stage is internal mapping only: stage = Math.ceil(boundary / 100)
 */

import { 
  getCachedTweetCountPg, 
  getUserBoundaryEndPg,
  getNewestCachedTweetTimestampPg,
  extractNewlyUnlockedPostsPg
} from "./repository";

// ─── Target Count Calculation ──────────────────────────────────────────────

/** 
 * Cutoff date for determining old vs new account excavation targets.
 * Accounts created before this date are considered "old" (target = 50).
 * Accounts created on or after this date are considered "new" (target = 100).
 */
const ACCOUNT_AGE_CUTOFF = "2016-01-01T00:00:00.000Z";

/**
 * Compute the target tweet count for a job based on the account's creation date.
 *
 *   created before 2016-01-01  →  50   (old accounts)
 *   created on/after 2016-01-01 → 100  (new accounts)
 *
 * Exported so callers can display the value before job creation.
 */
export function computeTargetCount(accountCreatedAt: string | null | undefined): number {
  if (!accountCreatedAt) return 100;
  const accountDate = new Date(accountCreatedAt);
  const cutoffDate = new Date(ACCOUNT_AGE_CUTOFF);
  
  return accountDate < cutoffDate ? 50 : 100;
}

// ─── Core Types ─────────────────────────────────────────────────────────────

export interface UnlockBoundary {
  /** Current posts unlocked by this user for this account (0, 100, 200, etc.) */
  current: number;
  /** Next target boundary after extend (+100) */
  next: number;
  /** Posts currently cached in DB for this account */
  cachedTotal: number;
  /** Posts missing from cache to reach target (0 if cache sufficient) */
  missingCount: number;
  /** Can fulfill from cache without excavation */
  cacheHit: boolean;
  /** Where excavation should continue from if needed */
  excavationContinueFrom: Date | null;
}

export interface ExtendPlan {
  /** Current boundary → next boundary info */
  boundary: UnlockBoundary;
  /** Decision: cache-only or excavation required */
  strategy: "cache-only" | "excavation";
  /** If excavation: start date for continuation */
  excavationStartDate: Date | null;
  /** If excavation: how many posts to excavate */
  excavationTargetCount: number;
}

export interface InitialUnlockPlan {
  /** Requested stage (planning label) */
  requestedStage: number;
  /** Target count based on account age and stage */
  targetCount: number;
  /** Posts currently cached in DB for this account */
  currentCachedCount: number;
  /** Current user boundary (0 for new unlock) */  
  currentUserBoundary: number;
  /** Whether excavation is needed */
  excavationNeeded: boolean;
  /** If cache hit: boundary to grant */
  grantBoundary?: number;
  /** Decision strategy */
  strategy: "cache-only" | "excavation";
}

export interface GuestUnlockPlan {
  /** Guest-specific target count (always Stage 1) */
  targetCount: number;
  /** Posts currently cached in DB for this account */
  currentCachedCount: number;
  /** Whether excavation is needed */
  excavationNeeded: boolean;
  /** If cache hit: boundary for guest access */
  guestBoundary?: number;
  /** Decision strategy */
  strategy: "cache-only" | "excavation";
}

export interface AdditionalExcavationPlan {
  /** User making the request */
  userId: string;
  /** Account being requested */
  accountId: string;
  /** Target boundary (currentVisibleBoundary + 100) */
  targetBoundary: number;
  /** Posts currently cached in DB for this account (account progress) */
  currentCachedCount: number;
  /** Current user visibility boundary (user entitlement) */
  currentVisibleBoundary: number;
  /** Whether excavation is needed */
  needToExcavate: boolean;
  /** How many tweets are missing from cache */
  missingCount: number;
  /** Execution mode based on missing count */
  executionMode: "grant_only" | "excavate_more";
  /** Expected final boundary after execution */
  expectedFinalBoundary: number;
}

// ─── Boundary Calculation ─────────────────────────────────────────────────

/**
 * Calculate current unlocked boundary for user+account.
 * Returns 0 if never unlocked, actual boundary from unlocks table.
 * 
 * CRITICAL: This is the ONLY source of truth for user unlocked counts.
 * UI must NEVER use account cached total or stage arithmetic directly.
 * 
 * Updated for Phase 6: Uses MAX(unlocks.boundary_end) instead of summing stage_results.
 */
export async function calculateUnlockedBoundary(userId: string, accountId: string): Promise<number> {
  return await getUserBoundaryEndPg(userId, accountId);
}

/**
 * Plan initial unlock for user+account (Postgres version).
 * This is the master planning function - all initial unlock logic flows through here.
 * Used by both cache-hit and fresh excavation flows to ensure consistent decisions.
 */
export async function planInitialUnlockPg(
  userId: string, 
  accountId: string | null, 
  requestedStage: number,
  accountCreatedAt: string | null
): Promise<InitialUnlockPlan> {
  // Step 1: Determine target count based on account age and stage
  const targetCount = requestedStage === 1 ? computeTargetCount(accountCreatedAt) : 100 * requestedStage;
  
  // Step 2: Current user boundary (should be 0 for initial unlock, but check anyway)
  const currentUserBoundary = accountId ? await getUserBoundaryEndPg(userId, accountId) : 0;
  
  // Step 3: Current cached count (0 if account doesn't exist yet)
  const currentCachedCount = accountId ? await getCachedTweetCountPg(accountId) : 0;
  
  // Step 4: Determine if excavation is needed
  const excavationNeeded = currentCachedCount < targetCount;
  
  // Step 5: For cache hits, determine grant boundary
  const grantBoundary = excavationNeeded ? undefined : Math.min(targetCount, currentCachedCount);
  
  return {
    requestedStage,
    targetCount,
    currentCachedCount,
    currentUserBoundary,
    excavationNeeded,
    grantBoundary,
    strategy: excavationNeeded ? "excavation" : "cache-only",
  };
}

/**
 * Plan initial unlock for user+account (Legacy SQLite version - kept for backward compatibility).
 * This is the master planning function - all initial unlock logic flows through here.
 * Used by both cache-hit and fresh excavation flows to ensure consistent decisions.
 * 
 * NOTE: This function is deprecated and only exists for backward compatibility.
 * Use planInitialUnlockPg instead for new code.
 */
export async function planInitialUnlock(
  userId: string, 
  accountId: string | null, 
  requestedStage: number,
  accountCreatedAt: string | null
): Promise<InitialUnlockPlan> {
  // Step 1: Determine target count based on account age and stage
  const targetCount = requestedStage === 1 ? computeTargetCount(accountCreatedAt) : 100 * requestedStage;
  
  // Step 2: Current user boundary (should be 0 for initial unlock, but check anyway)
  const currentUserBoundary = accountId ? await getUserBoundaryEndPg(userId, accountId) : 0;
  
  // Step 3: Current cached count (0 if account doesn't exist yet)
  // UPDATED: Now uses Postgres version
  const currentCachedCount = accountId ? await getCachedTweetCountPg(accountId) : 0;
  
  // Step 4: Determine if excavation is needed
  const excavationNeeded = currentCachedCount < targetCount;
  
  // Step 5: For cache hits, determine grant boundary
  const grantBoundary = excavationNeeded ? undefined : Math.min(targetCount, currentCachedCount);
  
  return {
    requestedStage,
    targetCount,
    currentCachedCount,
    currentUserBoundary,
    excavationNeeded,
    grantBoundary,
    strategy: excavationNeeded ? "excavation" : "cache-only",
  };
}

/**
 * Plan guest unlock for account.
 * Follows the same core principles as logged-in users but for guest-specific access.
 * Guests always get Stage 1 equivalent access.
 */
export async function planGuestUnlock(
  accountId: string | null,
  accountCreatedAt: string | null
): Promise<GuestUnlockPlan> {
  // Step 1: Determine target count based on account age (always Stage 1 for guests)
  const targetCount = computeTargetCount(accountCreatedAt);
  
  // Step 2: Current cached count (0 if account doesn't exist yet)
  const currentCachedCount = accountId ? await getCachedTweetCountPg(accountId) : 0;
  
  // Step 3: Determine if excavation is needed
  const excavationNeeded = currentCachedCount < targetCount;
  
  // Step 4: For cache hits, determine guest boundary (same as target for guests)
  const guestBoundary = excavationNeeded ? undefined : Math.min(targetCount, currentCachedCount);
  
  return {
    targetCount,
    currentCachedCount,
    excavationNeeded,
    guestBoundary,
    strategy: excavationNeeded ? "excavation" : "cache-only",
  };
}

/**
 * Plan additional excavation for user+account.
 * Target boundary = currentVisibleBoundary + 100 (exact, not rounded to stage).
 */
export async function planAdditionalExcavation(
  userId: string,
  accountId: string, 
  targetBoundary: number
): Promise<AdditionalExcavationPlan> {
  // Current cached count (account progress from cached tweets only)
  const currentCachedCount = await getCachedTweetCountPg(accountId);
  
  // Current visible boundary (user entitlement from boundary_end only)
  const currentVisibleBoundary = await getUserBoundaryEndPg(userId, accountId);
  
  // Missing count based on target vs cached
  const missingCount = Math.max(0, targetBoundary - currentCachedCount);
  
  // Execution mode
  const needToExcavate = missingCount > 0;
  const executionMode: "grant_only" | "excavate_more" = needToExcavate ? "excavate_more" : "grant_only";
  
  // Expected final boundary
  const expectedFinalBoundary = Math.min(targetBoundary, currentCachedCount + missingCount);
  
  return {
    userId,
    accountId,
    targetBoundary,
    currentCachedCount,
    currentVisibleBoundary,
    needToExcavate,
    missingCount,
    executionMode,
    expectedFinalBoundary,
  };
}

/**
 * Validate Phase 7 planning rules are correctly applied.
 * This helps ensure the planning function follows the required constraints.
 */
export function validateAdditionalExcavationPlan(plan: AdditionalExcavationPlan): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  // Rule: missingCount = max(0, targetBoundary - currentCachedCount) 
  const expectedMissingCount = Math.max(0, plan.targetBoundary - plan.currentCachedCount);
  if (plan.missingCount !== expectedMissingCount) {
    errors.push(`missingCount (${plan.missingCount}) should be max(0, targetBoundary - currentCachedCount) (${expectedMissingCount})`);
  }

  if (plan.missingCount === 0 && plan.executionMode !== "grant_only") {
    errors.push(`executionMode should be "grant_only" when missingCount is 0`);
  }

  if (plan.missingCount > 0 && plan.executionMode !== "excavate_more") {
    errors.push(`executionMode should be "excavate_more" when missingCount > 0`);
  }

  if (plan.needToExcavate !== (plan.missingCount > 0)) {
    errors.push(`needToExcavate (${plan.needToExcavate}) should match missingCount > 0 (${plan.missingCount > 0})`);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Get current unlock boundary and plan for next +100 extension.
 * This is the master planning function - all extend logic flows through here.
 */
export async function planExtension(userId: string, accountId: string): Promise<ExtendPlan> {
  // Step 1: Current user boundary
  const currentBoundary = await calculateUnlockedBoundary(userId, accountId);
  const nextBoundary = currentBoundary + 100;
  
  // Step 2: Account cached total (planning only)
  const cachedTotal = await getCachedTweetCountPg(accountId);
  
  // Step 3: Cache sufficiency check
  const missingCount = Math.max(0, nextBoundary - cachedTotal);
  const cacheHit = missingCount === 0;
  
  // Step 4: Excavation start point (if needed)
  let excavationStartDate: Date | null = null;
  let excavationContinueFrom: Date | null = null;
  
  if (!cacheHit) {
    // Need excavation - determine where to continue from
    excavationStartDate = getExcavationContinuePoint(accountId, cachedTotal);
    excavationContinueFrom = excavationStartDate;
  }
  
  const boundary: UnlockBoundary = {
    current: currentBoundary,
    next: nextBoundary,
    cachedTotal,
    missingCount,
    cacheHit,
    excavationContinueFrom,
  };
  
  return {
    boundary,
    strategy: cacheHit ? "cache-only" : "excavation",
    excavationStartDate,
    excavationTargetCount: missingCount,
  };
}

// ─── Excavation Continuation Logic ─────────────────────────────────────────

/**
 * Determine where excavation should continue from to fill the gap (Postgres version).
 * This is CRITICAL - wrong logic here makes the feature fake.
 * 
 * @param accountId Account to excavate
 * @param cachedCount Posts currently in cache
 * @returns Date to start excavation from (null if can't determine)
 */
export async function getExcavationContinuePointPg(accountId: string, cachedCount: number): Promise<Date | null> {
  if (cachedCount === 0) {
    // No posts cached - start from earliest (normal excavation)
    return null;
  }
  
  // Find the timestamp of the newest cached post
  // Excavation should continue from just after this point
  const newestTimestamp = await getNewestCachedTweetTimestampPg(accountId);
  
  if (!newestTimestamp) {
    return null; // No posts found despite cachedCount > 0 (data inconsistency)
  }
  
  // Start excavation from 1 second after the newest post
  // This ensures no overlap and proper continuation
  const lastPostDate = new Date(newestTimestamp);
  return new Date(lastPostDate.getTime() + 1000);
}

/**
 * Determine where excavation should continue from to fill the gap (Legacy SQLite version).
 * This is CRITICAL - wrong logic here makes the feature fake.
 * 
 * @param accountId Account to excavate
 * @param cachedCount Posts currently in cache
 * @returns Date to start excavation from (null if can't determine)
 */
export function getExcavationContinuePoint(accountId: string, cachedCount: number): Date | null {
  if (cachedCount === 0) {
    // No posts cached - start from earliest (normal excavation)
    return null;
  }
  
  // TEMPORARY: Legacy function - should be migrated to Postgres version
  return null; // Simplified for now
}

// ─── Validation & Safety ───────────────────────────────────────────────────

/**
 * Validate that extend is possible and safe for this user+account.
 * Returns error message if invalid, null if valid.
 */
export async function validateExtendRequest(userId: string, accountId: string): Promise<string | null> {
  const currentBoundary = await calculateUnlockedBoundary(userId, accountId);
  
  if (userId === 'anonymous') {
    console.log(`[DEBUG] validateExtendRequest: userId=${userId}, accountId=${accountId}, currentBoundary=${currentBoundary}`);
  }
  
  // TEMPORARY: Allow testing with anonymous user only
  if (userId === 'anonymous') {
    console.log(`[DEBUG] Bypassing validation for anonymous user`);
    return null; // Allow for testing
  }
  
  // Must have unlocked at least stage 1 (100 posts)
  if (currentBoundary === 0) {
    return "Must unlock initial posts before extending";
  }
  
  // Check reasonable limits (prevent abuse)
  const maxBoundary = 100000000; // Allow up to 100000000 posts total
  if (currentBoundary >= maxBoundary) {
    return `Maximum unlock limit reached (${maxBoundary} posts)`;
  }
  
  return null; // Valid
}

// ─── Result Range Calculation ──────────────────────────────────────────────

/**
 * Calculate the exact post range that should be shown on result page.
 * For extend operations, this is ONLY the newly unlocked block.
 * 
 * Example: user had 100, extended to 200 → return "101-200"
 */
export interface ResultRange {
  /** First post number in newly unlocked block (1-indexed) */
  start: number;
  /** Last post number in newly unlocked block (1-indexed) */
  end: number;
  /** Human readable range string */
  rangeString: string;
  /** Total posts in this range */
  count: number;
}

export function calculateResultRange(previousBoundary: number, newBoundary: number): ResultRange {
  const start = previousBoundary + 1;
  const end = newBoundary;
  const count = end - start + 1;
  
  return {
    start,
    end,
    rangeString: `${start}-${end}`,
    count,
  };
}

// ─── Cache Filtering ───────────────────────────────────────────────────────

/**
 * Extract ONLY the newly unlocked posts from cache for result display.
 * This ensures result page shows only posts 101-200, not 1-200.
 * 
 * @param accountId Account to query
 * @param resultRange Range of posts to extract
 * @returns Posts in the specified range only
 */
/**
 * Extract ONLY the newly unlocked posts from cache for result display (Postgres version).
 * This ensures result page shows only posts 101-200, not 1-200.
 */
export async function extractNewlyUnlockedPostsPgByRange(accountId: string, resultRange: ResultRange): Promise<any[]> {
  const startIndex = resultRange.start - 1; // Convert to 0-indexed
  const count = resultRange.count;
  
  const extractedPosts = await extractNewlyUnlockedPostsPg(accountId, startIndex, count);
  
  console.log(`[extract] Extracted ${extractedPosts.length} posts for range ${resultRange.rangeString}`);
  return extractedPosts;
}

/* REMOVED: extractNewlyUnlockedPosts - replaced with extractNewlyUnlockedPostsPgByRange */