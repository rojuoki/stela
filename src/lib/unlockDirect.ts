/**
 * Direct unlock operations - extracted from /api/unlock for reuse in webhooks
 */

import { upsertUnlockBoundary } from "./unlockWrite";
import { 
  getAccountByUsername,
  hasUserUnlockedAccount,
  getCreditBalance,
  spendCreditsPg,
  cleanupExpiredHoldsPg,
  giveCreditsPg,
  recordApiCall
} from "./repository";
import { planInitialUnlock } from "./unlockPlanning";
import { createAndRunJob } from "./jobs";
import { normalizeUsername } from "./validation";

export interface UnlockResult {
  success: boolean;
  error?: string;
  accountId?: string;
  jobId?: string | null;
  status?: string;
  creditConsumed?: boolean;
  freeReUnlock?: boolean;
}

/**
 * Perform direct unlock operation - core logic extracted from /api/unlock
 * Used by webhook handlers to process paid unlocks without HTTP layer
 */
export async function performDirectUnlock(
  userId: string,
  username: string,
  _stage: number = 1  // Legacy param, ignored — boundary is source of truth
): Promise<UnlockResult> {
  try {
    console.log(`[unlockDirect] Processing unlock for user ${userId}, @${username}`);

    // Normalize username
    const normalizedUsername = normalizeUsername(username);
    if (!normalizedUsername) {
      return {
        success: false,
        error: "Invalid username format. Must be 1-15 characters, letters/numbers/underscore only."
      };
    }

    // Clean up expired holds and ensure user has starting credits
    await cleanupExpiredHoldsPg();
    const userBalance = await getCreditBalance(userId);
    if (userBalance.total_earned === 0) {
      await giveCreditsPg(userId, 3, "Initial allocation");
    }

    // Unified decision planning (always stage 1 for initial unlock)
    const account = await getAccountByUsername(normalizedUsername);
    const plan = await planInitialUnlock(userId, account?.account_id || null, 1, account?.created_at || null);
    
    console.log(`[unlockDirect] @${normalizedUsername} plan:`, {
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
      const alreadyUnlocked = await hasUserUnlockedAccount(userId, account.account_id);
      
      if (alreadyUnlocked) {
        await upsertUnlockBoundary(userId, account.account_id, plan.grantBoundary, "paid-unlock-free");
        await recordApiCall("cache/unlock", true);
        console.log(`[unlockDirect] Free cache hit for @${normalizedUsername}`);
        
        return {
          success: true,
          accountId: account.account_id,
          jobId: null,
          status: "cache-hit",
          freeReUnlock: true,
          creditConsumed: false,
        };
      } else {
        await upsertUnlockBoundary(userId, account.account_id, plan.grantBoundary, "paid-unlock-cache");
        await recordApiCall("cache/unlock", true);
        console.log(`[unlockDirect] Paid cache hit for @${normalizedUsername}`);
        
        return {
          success: true,
          accountId: account.account_id,
          jobId: null,
          status: "cache-hit",
          freeReUnlock: false,
          creditConsumed: true,
        };
      }
    }

    // Create excavation job - credit already paid via Stripe, no hold needed
    const jobId = await createAndRunJob(normalizedUsername, account?.created_at, undefined, 1, false, userId);

    console.log(`[unlockDirect] Created job ${jobId} for @${normalizedUsername} (paid unlock)`);
    
    return {
      success: true,
      accountId: account.account_id,
      jobId,
      status: "queued",
      creditConsumed: true,
    };
    
  } catch (error) {
    console.error('[unlockDirect] Unexpected error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Internal server error"
    };
  }
}