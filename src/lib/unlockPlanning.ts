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

import { getDb } from "./db";
import { getCachedTweetCount, getUserBoundaryEnd } from "./repository";

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
  /** Internal stage numbers for DB operations */
  internal: {
    currentStage: number;
    nextStage: number;
  };
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
  /** Requested stage (planning label) */
  requestedStage: number;
  /** Target count based on requested stage */
  targetCount: number;
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
export function calculateUnlockedBoundary(userId: string, accountId: string): number {
  return getUserBoundaryEnd(userId, accountId);
}

/**
 * Plan initial unlock for user+account.
 * This is the master planning function - all initial unlock logic flows through here.
 * Used by both cache-hit and fresh excavation flows to ensure consistent decisions.
 */
export function planInitialUnlock(
  userId: string, 
  accountId: string | null, 
  requestedStage: number,
  accountCreatedAt: string | null
): InitialUnlockPlan {
  // Step 1: Determine target count based on account age and stage
  const targetCount = requestedStage === 1 ? computeTargetCount(accountCreatedAt) : 100 * requestedStage;
  
  // Step 2: Current user boundary (should be 0 for initial unlock, but check anyway)
  const currentUserBoundary = accountId ? getUserBoundaryEnd(userId, accountId) : 0;
  
  // Step 3: Current cached count (0 if account doesn't exist yet)
  const currentCachedCount = accountId ? getCachedTweetCount(accountId) : 0;
  
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
export function planGuestUnlock(
  accountId: string | null,
  accountCreatedAt: string | null
): GuestUnlockPlan {
  // Step 1: Determine target count based on account age (always Stage 1 for guests)
  const targetCount = computeTargetCount(accountCreatedAt);
  
  // Step 2: Current cached count (0 if account doesn't exist yet)
  const currentCachedCount = accountId ? getCachedTweetCount(accountId) : 0;
  
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
 * This is the Phase 7 planning function for extend/additional excavation requests.
 * Provides explicit and inspectable planning results following core data model rules.
 */
export function planAdditionalExcavation(
  userId: string,
  accountId: string, 
  requestedStage: number
): AdditionalExcavationPlan {
  // Step 1: Determine target count from requested stage (stage as planning label)
  const targetCount = requestedStage * 100; // Stage 2 = 200, Stage 3 = 300, etc.
  
  // Step 2: Current cached count (account progress from cached tweets only)
  const currentCachedCount = getCachedTweetCount(accountId);
  
  // Step 3: Current visible boundary (user entitlement from boundary_end only)
  const currentVisibleBoundary = getUserBoundaryEnd(userId, accountId);
  
  // Step 4: Calculate missing count based on target vs cached
  const missingCount = Math.max(0, targetCount - currentCachedCount);
  
  // Step 5: Determine execution mode
  const needToExcavate = missingCount > 0;
  const executionMode: "grant_only" | "excavate_more" = needToExcavate ? "excavate_more" : "grant_only";
  
  // Step 6: Expected final boundary (user will see up to target count)
  const expectedFinalBoundary = Math.min(targetCount, currentCachedCount + missingCount);
  
  return {
    userId,
    accountId,
    requestedStage,
    targetCount,
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

  // Rule: targetCount comes from requestedStage
  const expectedTargetCount = plan.requestedStage * 100;
  if (plan.targetCount !== expectedTargetCount) {
    errors.push(`targetCount (${plan.targetCount}) should be requestedStage * 100 (${expectedTargetCount})`);
  }

  // Rule: missingCount = max(0, targetCount - currentCachedCount) 
  const expectedMissingCount = Math.max(0, plan.targetCount - plan.currentCachedCount);
  if (plan.missingCount !== expectedMissingCount) {
    errors.push(`missingCount (${plan.missingCount}) should be max(0, targetCount - currentCachedCount) (${expectedMissingCount})`);
  }

  // Rule: if missingCount == 0, executionMode = "grant_only"
  if (plan.missingCount === 0 && plan.executionMode !== "grant_only") {
    errors.push(`executionMode should be "grant_only" when missingCount is 0`);
  }

  // Rule: if missingCount > 0, executionMode = "excavate_more" 
  if (plan.missingCount > 0 && plan.executionMode !== "excavate_more") {
    errors.push(`executionMode should be "excavate_more" when missingCount > 0`);
  }

  // Rule: needToExcavate should match missingCount > 0
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
export function planExtension(userId: string, accountId: string): ExtendPlan {
  // Step 1: Current user boundary
  const currentBoundary = calculateUnlockedBoundary(userId, accountId);
  const nextBoundary = currentBoundary + 100;
  
  // Step 2: Account cached total (planning only)
  const cachedTotal = getCachedTweetCount(accountId);
  
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
  
  // Step 5: Internal stage mapping (for DB operations only)
  const currentStage = Math.ceil(currentBoundary / 100);
  const nextStage = Math.ceil(nextBoundary / 100);
  
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
    internal: {
      currentStage,
      nextStage,
    },
  };
}

// ─── Excavation Continuation Logic ─────────────────────────────────────────

/**
 * Determine where excavation should continue from to fill the gap.
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
  
  // Find the timestamp of the newest cached post
  // Excavation should continue from just after this point
  const db = getDb();
  const newestPost = db.prepare(`
    SELECT created_at 
    FROM tweets 
    WHERE account_id = ? 
    ORDER BY created_at DESC 
    LIMIT 1
  `).get(accountId) as { created_at: string } | undefined;
  
  if (!newestPost) {
    return null; // No posts found despite cachedCount > 0 (data inconsistency)
  }
  
  // Start excavation from 1 second after the newest post
  // This ensures no overlap and proper continuation
  const lastPostDate = new Date(newestPost.created_at);
  return new Date(lastPostDate.getTime() + 1000);
}

// ─── Validation & Safety ───────────────────────────────────────────────────

/**
 * Validate that extend is possible and safe for this user+account.
 * Returns error message if invalid, null if valid.
 */
export function validateExtendRequest(userId: string, accountId: string): string | null {
  const currentBoundary = calculateUnlockedBoundary(userId, accountId);
  
  // Must have unlocked at least stage 1 (100 posts)
  if (currentBoundary === 0) {
    return "Must unlock initial posts before extending";
  }
  
  // Check reasonable limits (prevent abuse)
  const maxBoundary = 1000; // Allow up to 1000 posts total
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
export function extractNewlyUnlockedPosts(accountId: string, resultRange: ResultRange): any[] {
  const db = getDb();
  
  // Get posts in chronological order, then slice to the target range
  const allPosts = db.prepare(`
    SELECT 
      post_id,
      account_id,
      created_at,
      full_text,
      media_json,
      like_count,
      retweet_count,
      reply_count,
      fetched_at
    FROM tweets 
    WHERE account_id = ? 
    ORDER BY created_at ASC
  `).all(accountId) as any[];
  
  // Validate that we have enough posts for the requested range
  if (allPosts.length < resultRange.end) {
    console.warn(`[extract] Not enough cached posts: have ${allPosts.length}, need ${resultRange.end} for range ${resultRange.rangeString}`);
    // Return what we have in the range
    const startIndex = Math.max(0, resultRange.start - 1);
    return allPosts.slice(startIndex);
  }
  
  // Extract only the newly unlocked slice
  const startIndex = resultRange.start - 1; // Convert to 0-indexed
  const endIndex = resultRange.end; // slice() end is exclusive
  
  const extractedPosts = allPosts.slice(startIndex, endIndex);
  
  console.log(`[extract] Extracted ${extractedPosts.length} posts for range ${resultRange.rangeString} from ${allPosts.length} total cached`);
  
  return extractedPosts;
}