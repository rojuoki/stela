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
import { getCachedTweetCount, getUserHighestUnlockedStage } from "./repository";

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
  const { getUserBoundaryEnd } = require("./repository");
  return getUserBoundaryEnd(userId, accountId);
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