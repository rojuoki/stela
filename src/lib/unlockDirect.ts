/**
 * Direct unlock operations - extracted from /api/unlock for reuse in webhooks
 */

import { 
  getAccountByUsername,
  hasUserUnlockedAccount,
  hasUserUnlockedStage,
  getCreditBalance,
  spendCredits,
  recordStageUnlock,
  cleanupExpiredHolds,
  giveCredits,
  recordApiCall
} from "./repository";
import { planInitialUnlock } from "./unlockPlanning";
import { createAndRunJob, createStageExpansionJob } from "./jobs";
import { normalizeUsername } from "./validation";

export interface UnlockResult {
  success: boolean;
  error?: string;
  accountId?: string;
  jobId?: string | null;
  status?: string;
  stage?: number;
  creditConsumed?: boolean;
  freeReUnlock?: boolean;
}

/**
 * Perform direct unlock operation - core logic extracted from /api/unlock
 * Used by webhook handlers to process paid unlocks without HTTP layer
 */
export function performDirectUnlock(
  userId: string,
  username: string,
  stage: number = 1
): UnlockResult {
  try {
    console.log(`[unlockDirect] Processing unlock for user ${userId}, @${username}, stage ${stage}`);

    // Normalize username
    const normalizedUsername = normalizeUsername(username);
    if (!normalizedUsername) {
      return {
        success: false,
        error: "Invalid username format. Must be 1-15 characters, letters/numbers/underscore only."
      };
    }

    // Validate stage
    const requestedStage = Math.max(1, Math.min(3, Math.floor(stage)));

    // Clean up expired holds and ensure user has starting credits
    cleanupExpiredHolds();
    const userBalance = getCreditBalance(userId);
    if (userBalance.total_earned === 0) {
      // First time user - give starting credits
      giveCredits(userId, 3, "Initial allocation");
    }

    // Unified decision planning
    const account = getAccountByUsername(normalizedUsername);
    const plan = planInitialUnlock(userId, account?.account_id || null, requestedStage, account?.created_at || null);
    
    console.log(`[unlockDirect] @${normalizedUsername} Stage ${requestedStage} plan:`, {
      targetCount: plan.targetCount,
      currentCachedCount: plan.currentCachedCount,
      strategy: plan.strategy
    });

    if (!account) {
      return {
        success: false,
        error: "Account not found or not yet excavated"
      };
    }

    // Cache-only path: sufficient posts already cached
    if (plan.strategy === "cache-only" && plan.grantBoundary) {
      const alreadyUnlocked = hasUserUnlockedAccount(userId, account.account_id);
      
      if (alreadyUnlocked) {
        // Free re-unlock for same user (already unlocked)
        recordStageUnlock(userId, account.account_id, requestedStage, plan.grantBoundary, plan.grantBoundary, "paid-unlock-free");
        recordApiCall("cache/unlock", true);
        console.log(`[unlockDirect] Free cache hit for @${normalizedUsername} Stage ${requestedStage}`);
        
        return {
          success: true,
          accountId: account.account_id,
          jobId: null,
          status: "cache-hit",
          stage: requestedStage,
          freeReUnlock: true,
          creditConsumed: false,
        };
      } else {
        // First time unlock from cache - credit already paid via Stripe
        recordStageUnlock(userId, account.account_id, requestedStage, plan.grantBoundary, plan.grantBoundary, "paid-unlock-cache");
        recordApiCall("cache/unlock", true);

        console.log(`[unlockDirect] Paid cache hit for @${normalizedUsername} Stage ${requestedStage}`);
        
        return {
          success: true,
          accountId: account.account_id,
          jobId: null,
          status: "cache-hit",
          stage: requestedStage,
          freeReUnlock: false,
          creditConsumed: true, // Credit was consumed via Stripe payment
        };
      }
    }

    // Stage-specific prerequisite checking for stage 2+
    if (requestedStage > 1) {
      if (hasUserUnlockedStage(userId, account.account_id, requestedStage)) {
        return {
          success: false,
          error: `You already have Stage ${requestedStage} unlocked for @${normalizedUsername}`,
          accountId: account.account_id,
          stage: requestedStage
        };
      }
    }

    // Create excavation job - credit already paid via Stripe, no hold needed
    let jobId: string;
    
    if (requestedStage === 1) {
      // Stage 1: Use normal job creation
      jobId = createAndRunJob(normalizedUsername, account?.created_at, undefined, 1, false, userId);
    } else {
      // Stage 2+: Use expansion job creation
      const expansionResult = createStageExpansionJob(normalizedUsername, requestedStage, undefined, userId);
      if (expansionResult.error) {
        return {
          success: false,
          error: expansionResult.error,
          stage: requestedStage
        };
      }
      jobId = expansionResult.jobId!;
    }

    console.log(`[unlockDirect] Created job ${jobId} for @${normalizedUsername} Stage ${requestedStage} (paid unlock)`);
    
    return {
      success: true,
      accountId: account.account_id,
      jobId,
      status: "queued",
      stage: requestedStage,
      creditConsumed: true, // Credit was consumed via Stripe payment
    };
    
  } catch (error) {
    console.error('[unlockDirect] Unexpected error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Internal server error"
    };
  }
}