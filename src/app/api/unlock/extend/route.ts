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
  validateExtendRequest, 
  calculateResultRange,
  extractNewlyUnlockedPosts 
} from "@/lib/unlockPlanning";
import { 
  getAccountByUsername, 
  getCreditBalance, 
  holdCredits, 
  captureHeld,
  releaseHeld,
  spendCredits,
  recordStageUnlock,
  cleanupExpiredHolds 
} from "@/lib/repository";
import { normalizeUsername, checkRateLimit } from "@/lib/validation";
import { createAndRunJob, createStageExpansionJob } from "@/lib/jobs";
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
    cleanupExpiredHolds();
    const userBalance = getCreditBalance(userId);
    if (userBalance.total_earned === 0) {
      // First time user - give starting credits (should not happen for extend, but safety)
      const { giveCredits } = await import("@/lib/repository");
      giveCredits(userId, 3, "Initial allocation");
    }

    // Find account
    const account = getAccountByUsername(username);
    if (!account) {
      return NextResponse.json({ 
        error: `Account @${username} not found. Use regular unlock first.` 
      }, { status: 404 });
    }

    // Validate extend request
    const validationError = validateExtendRequest(userId, account.account_id);
    if (validationError) {
      return NextResponse.json({ error: validationError }, { status: 400 });
    }

    // Plan the extension using centralized logic
    const plan = planExtension(userId, account.account_id);
    
    console.log(`[extend] @${username} planning:`, {
      currentBoundary: plan.boundary.current,
      nextBoundary: plan.boundary.next,
      cachedTotal: plan.boundary.cachedTotal,
      strategy: plan.strategy,
      missingCount: plan.boundary.missingCount,
    });

    // ── Cache-only path: sufficient posts already cached ──
    if (plan.strategy === "cache-only") {
      // Check credit balance for cache-hit extend
      const currentBalance = getCreditBalance(userId);
      if (currentBalance.balance < 1) {
        return NextResponse.json({
          error: "Insufficient credits",
          balance: currentBalance.balance,
          required: 1,
        }, { status: 402 });
      }

      // Spend credit immediately (synchronous cache operation)
      const spent = spendCredits(userId, 1, `Cache extend to ${plan.boundary.next} posts for @${username}`);
      if (!spent) {
        return NextResponse.json({
          error: "Failed to deduct credits",
          balance: currentBalance.balance,
        }, { status: 500 });
      }

      // Record unlock for next stage
      recordStageUnlock(
        userId, 
        account.account_id, 
        plan.internal.nextStage, 
        plan.boundary.next, 
        plan.boundary.next - plan.boundary.current, 
        "cache-extend"
      );
      
      // Calculate result range for newly unlocked block
      const resultRange = calculateResultRange(plan.boundary.current, plan.boundary.next);
      
      // Extract ONLY the newly unlocked posts
      const newlyUnlockedPosts = extractNewlyUnlockedPosts(account.account_id, resultRange);

      console.log(`[extend] Cache-hit extend for @${username}: ${plan.boundary.current} → ${plan.boundary.next}, showing range ${resultRange.rangeString}`);

      return NextResponse.json({
        success: true,
        strategy: "cache-hit",
        boundary: {
          previous: plan.boundary.current,
          new: plan.boundary.next,
        },
        range: {
          start: resultRange.start,
          end: resultRange.end,
          count: resultRange.count,
          rangeString: resultRange.rangeString,
        },
        posts: newlyUnlockedPosts, // Immediate posts for cache-hit
        accountId: account.account_id,
        creditConsumed: true,
      });
    }

    // ── Excavation path: need to excavate missing posts ──
    
    // Check credit balance for excavation
    const creditBalance = getCreditBalance(userId);
    if (creditBalance.balance < 1) {
      return NextResponse.json({
        error: "Insufficient credits",
        balance: creditBalance.balance,
        required: 1,
      }, { status: 402 });
    }

    // Create extend job using normal job creation but with extend metadata
    const jobId = createAndRunJob(
      username, 
      account.created_at,
      undefined, // holdId will be set separately
      plan.internal.nextStage, // Target stage
      false, // not force
      userId // requesting user
    );
    
    // Add extend metadata to the job's resume_state
    const extendMetadata = {
      type: 'forward_continuation',
      currentBoundary: plan.boundary.current,
      targetBoundary: plan.boundary.next,
      missingCount: plan.boundary.missingCount,
    };
    
    const { getDb } = await import("@/lib/db");
    const db = getDb();
    db.prepare("UPDATE jobs SET resume_state = ? WHERE id = ?").run(
      JSON.stringify(extendMetadata),
      jobId
    );
    
    // Hold credit for excavation job
    const holdId = holdCredits(userId, jobId, 1);
    if (!holdId) {
      return NextResponse.json({
        error: "Failed to hold credits",
        balance: getCreditBalance(userId).balance,
      }, { status: 500 });
    }

    console.log(`[extend] Created excavation job ${jobId} for @${username}: ${plan.boundary.current} → ${plan.boundary.next}, excavating ${plan.boundary.missingCount} posts`);

    // Calculate the expected result range for frontend
    const expectedResultRange = calculateResultRange(plan.boundary.current, plan.boundary.next);

    return NextResponse.json({
      success: true,
      strategy: "excavation",
      jobId,
      holdId,
      boundary: {
        previous: plan.boundary.current,
        target: plan.boundary.next,
        excavationTarget: plan.boundary.missingCount,
      },
      range: {
        start: expectedResultRange.start,
        end: expectedResultRange.end,
        count: expectedResultRange.count,
        rangeString: expectedResultRange.rangeString,
      },
      accountId: account.account_id,
      creditHeld: true,
    }, { status: 202 });

  } catch (error) {
    console.error('[extend] Unexpected error:', error);
    return NextResponse.json({
      error: "Internal server error",
      message: error instanceof Error ? error.message : "Unknown error"
    }, { status: 500 });
  }
}