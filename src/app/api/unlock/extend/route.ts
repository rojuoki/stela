/**
 * STELA Additional Excavation Endpoint
 * 
 * Provides the next contiguous 100 posts after the current unlocked boundary.
 * This is NOT "show whatever is in DB" - it's "provide the next 100 posts".
 * 
 * Core rule: Additional excavation delivers the NEXT 100 posts for that user.
 * - Uses cached posts first when available
 * - Excavates ONLY the missing remainder when necessary
 * - Returns ONLY the newly unlocked block (e.g., posts 101-200)
 * 
 * CRITICAL: This endpoint must NEVER mix cached total with unlocked boundary.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserId } from "@/lib/getUserId";
import { 
  planExtension, 
  planAdditionalExcavation,
  validateExtendRequest, 
  calculateResultRange,
  extractNewlyUnlockedPostsPgByRange
} from "@/lib/unlockPlanning";
import { 
  getAccountByUsernamePg, 
  getCreditBalancePg, 
  holdCreditsPg, 
  captureHeldPg,
  releaseHeldPg,
  spendCreditsPg,
  recordStageUnlockPg,
  cleanupExpiredHoldsPg,
  getUserBoundaryEndPg
} from "@/lib/repository";
import { normalizeUsername, checkRateLimit } from "@/lib/validation";
import { createAndRunJob, createStageExpansionJob, createAdditionalExcavationJob } from "@/lib/jobs";
import { maybeInjectDevError } from "@/lib/devError";

export async function POST(req: NextRequest) {
  const userId = await getUserId(req);
  
  try {
    // Rate limiting
    const clientIp = req.headers.get("x-forwarded-for") || 
                     req.headers.get("x-real-ip") || 
                     "unknown";
    const rateCheck = checkRateLimit(clientIp);
    
    if (!rateCheck.allowed) {
      return NextResponse.json(
        { 
          error: "Too many requests", 
          retryAfter: Math.ceil((rateCheck.resetTime - Date.now()) / 1000)
        }, 
        { 
          status: 429,
          headers: {
            "Retry-After": String(Math.ceil((rateCheck.resetTime - Date.now()) / 1000)),
            "X-RateLimit-Remaining": "0",
            "X-RateLimit-Reset": String(Math.floor(rateCheck.resetTime / 1000)),
          }
        }
      );
    }

    // Dev error injection
    const injected = await maybeInjectDevError(req);
    if (injected) return injected;

    // Parse request
    let body: { username?: string };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const username = normalizeUsername(body.username ?? "");
    if (!username) {
      return NextResponse.json({ 
        error: "Invalid username format. Must be 1-15 characters, letters/numbers/underscore only." 
      }, { status: 400 });
    }

    // Clean up expired holds and ensure user credits
    await cleanupExpiredHoldsPg();
    const userBalance = await getCreditBalancePg(userId);
    if (userBalance.total_earned === 0) {
      // First time user - give starting credits (should not happen for extend, but safety)
      const { giveCreditsPg } = await import("@/lib/repository");
      await giveCreditsPg(userId, 3, "Initial allocation");
    }

    // Find account
    const account = await getAccountByUsernamePg(username);
    if (!account) {
      return NextResponse.json({ 
        error: `Account @${username} not found. Use regular unlock first.` 
      }, { status: 404 });
    }

    // Validate extend request
    const validationError = await validateExtendRequest(userId, account.account_id);
    if (validationError) {
      return NextResponse.json({ error: validationError }, { status: 400 });
    }

    // Phase 8: Use additional excavation planning result for execution
    let currentBoundary = account ? await getUserBoundaryEndPg(userId, account.account_id) : 0;
    
    // TEMPORARY: For testing with anonymous users only
    if (userId === 'anonymous' && currentBoundary === 0) {
      currentBoundary = 200; // Simulate Stage 2 completion for testing excavate_more
      console.log(`[DEBUG] Using test currentBoundary ${currentBoundary} for user ${userId} (testing excavate_more)`);
    }
    
    const nextStage = Math.ceil((currentBoundary + 100) / 100);
    
    const plan = await planAdditionalExcavation(userId, account.account_id, nextStage);
    console.log(`[extend] @${username} Phase 8 execution plan:`, {
      executionMode: plan.executionMode,
      targetCount: plan.targetCount,
      currentCachedCount: plan.currentCachedCount,
      currentVisibleBoundary: plan.currentVisibleBoundary,
      missingCount: plan.missingCount,
      expectedFinalBoundary: plan.expectedFinalBoundary,
    });

    // Phase 8 Execution: Grant Only Path
    if (plan.executionMode === "grant_only") {
      // Check credit balance
      const currentBalance = await getCreditBalancePg(userId);
      if (currentBalance.balance < 1) {
        return NextResponse.json({
          error: "Insufficient credits",
          balance: currentBalance.balance,
          required: 1,
        }, { status: 402 });
      }

      // Spend credit immediately (no excavation needed)
      const spent = await spendCreditsPg(userId, 1, `Grant access to ${plan.targetCount} posts for @${username} (no excavation)`);
      if (!spent) {
        return NextResponse.json({
          error: "Failed to deduct credits",
          balance: currentBalance.balance,
        }, { status: 500 });
      }

      // Phase 8: Update user entitlement to targetCount without excavating
      // granted_count reflects newly granted amount (targetCount - currentVisibleBoundary)
      const grantedCount = plan.targetCount - plan.currentVisibleBoundary;
      await recordStageUnlockPg(
        userId, 
        account.account_id, 
        plan.requestedStage, 
        plan.targetCount,  // boundary_end reaches targetCount
        grantedCount,      // newly granted amount only
        "additional-grant-only"
      );
      
      // Calculate result range for newly unlocked block
      const resultRange = calculateResultRange(plan.currentVisibleBoundary, plan.targetCount);
      
      // Extract posts from existing cache (no excavation occurred)
      const newlyUnlockedPosts = await extractNewlyUnlockedPostsPgByRange(account.account_id, resultRange);

      console.log(`[extend] Grant-only for @${username}: ${plan.currentVisibleBoundary} → ${plan.targetCount}, granted=${grantedCount} (no excavation)`);

      return NextResponse.json({
        success: true,
        executionMode: "grant_only",
        boundary: {
          previous: plan.currentVisibleBoundary,
          new: plan.targetCount,
        },
        range: {
          start: resultRange.start,
          end: resultRange.end,
          count: resultRange.count,
          rangeString: resultRange.rangeString,
        },
        posts: newlyUnlockedPosts,
        accountId: account.account_id,
        creditConsumed: true,
        excavated: false,
      });
    }

    // Phase 8 Execution: Excavate More Path
    if (plan.executionMode === "excavate_more") {
      // Check credit balance for excavation
      const creditBalance = await getCreditBalancePg(userId);
      if (creditBalance.balance < 1) {
        return NextResponse.json({
          error: "Insufficient credits",
          balance: creditBalance.balance,
          required: 1,
        }, { status: 402 });
      }

      // Create additional excavation job using existing excavation engine
      const jobId = await createAdditionalExcavationJob(
        username,
        plan.requestedStage,
        plan.missingCount, // How many tweets we need to excavate
        userId
      );
      
      if (!jobId) {
        return NextResponse.json({
          error: "Failed to create excavation job",
        }, { status: 500 });
      }
      
      // Hold credit for excavation job
      const holdId = await holdCreditsPg(userId, jobId, 1);
      if (!holdId) {
        return NextResponse.json({
          error: "Failed to hold credits",
          balance: (await getCreditBalancePg(userId)).balance,
        }, { status: 500 });
      }

      console.log(`[extend] Created additional excavation job ${jobId} for @${username}: need ${plan.missingCount} more posts to reach ${plan.targetCount}`);

      return NextResponse.json({
        success: true,
        executionMode: "excavate_more",
        jobId,
        holdId,
        planning: {
          currentCachedCount: plan.currentCachedCount,
          currentVisibleBoundary: plan.currentVisibleBoundary,
          targetCount: plan.targetCount,
          missingCount: plan.missingCount,
          expectedFinalBoundary: plan.expectedFinalBoundary,
        },
        accountId: account.account_id,
        creditHeld: true,
      }, { status: 202 });
    }

    // Should not reach here
    return NextResponse.json({
      error: "Invalid execution mode",
      executionMode: plan.executionMode,
    }, { status: 500 });

  } catch (error) {
    console.error('[extend] Unexpected error:', error);
    return NextResponse.json({
      error: "Internal server error",
      message: error instanceof Error ? error.message : "Unknown error"
    }, { status: 500 });
  }
}