import { NextRequest, NextResponse } from "next/server";
import { createAndRunJob, createStageExpansionJob, computeTargetCount } from "@/lib/jobs";
import { getStageResult } from "@/lib/stageResults";
import {
  getAccountByUsername,
  getCachedTweetCount,
  findActiveJobForUsername,
  hasUserUnlockedAccount,
  hasUserUnlockedStage,
  recordUnlock,
  recordStageUnlock,
  getCreditBalance,
  holdCredits,
  captureHeld,
  spendCredits,
  giveCredits,
  cleanupExpiredHolds,
  recordApiCall,
} from "@/lib/repository";
import { normalizeUsername, checkRateLimit } from "@/lib/validation";
import { getUserId } from "@/lib/getUserId";
import { maybeInjectDevError } from "@/lib/devError";
import { withDevMeasure, type MeasureCtx } from "@/lib/devMeasure";

const DEV_PANEL = process.env.NEXT_PUBLIC_DEV_PANEL === "1";

export async function POST(req: NextRequest) {
  const userId = await getUserId(req);
  const mCtx: MeasureCtx = { userId, route: "/api/unlock" };
  return withDevMeasure("unlock", async () => {
  const injected = await maybeInjectDevError(req);
  if (injected) return injected;

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

    let body: { username?: string; limit?: number; force?: boolean; stage?: number };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    // Input validation and normalization
    const username = normalizeUsername(body.username ?? "");
    mCtx.username = username || undefined; // propagate to stats entry
    if (!username) {
      return NextResponse.json({ 
        error: "Invalid username format. Must be 1-15 characters, letters/numbers/underscore only." 
      }, { status: 400 });
    }

    // Stage parameter validation (defaults to 1)
    const requestedStage = Math.max(1, Math.min(3, Math.floor(body.stage ?? 1))); // Clamp to 1-3
    
    // force=true bypasses cache and idempotency, always creates a new excavation job.
    // Credit rule: force=true always holds 1 credit (same as a fresh first-time unlock).
    const force = body.force === true;
    if (DEV_PANEL) console.log(`[dev] user_id=${userId} POST /api/unlock username=${body.username} stage=${requestedStage}`);

    // Clean up expired holds and ensure user has starting credits
    cleanupExpiredHolds();
    const userBalance = getCreditBalance(userId);
    if (userBalance.total_earned === 0) {
      // First time user - give starting credits
      giveCredits(userId, 3, "Initial allocation");
    }

    // ── Cache check: skipped entirely when force=true, Stage 1 only ──
    if (!force && requestedStage === 1) {
      const account = getAccountByUsername(username);
      if (account) {
        const cachedCount = getCachedTweetCount(account.account_id);
        if (cachedCount > 0) {
          const alreadyUnlockedStage1 = hasUserUnlockedStage(userId, account.account_id, 1);
          
          if (alreadyUnlockedStage1) {
            // Free re-unlock for same user (Stage 1 already unlocked)
            recordStageUnlock(userId, account.account_id, 1, "cache-hit-free");
            recordApiCall("cache/unlock", true); // saved: no excavation needed
            console.log(`[unlock] Free cache hit for @${username} Stage 1: ${cachedCount} tweets, user already unlocked`);
            
            return NextResponse.json({
              jobId: null,
              status: "cache-hit",
              stage: 1,
              accountId: account.account_id,
              cachedCount,
              freeReUnlock: true,
              creditConsumed: false,
            });
          } else {
            // First time unlock from cache - still consumes credit
            const currentBalance = getCreditBalance(userId);
            if (currentBalance.balance < 1) {
              return NextResponse.json({
                error: "Insufficient credits",
                balance: currentBalance.balance,
                required: 1,
              }, { status: 402 });
            }
            
            // Cache-hit is synchronous — spend directly (no async job → no hold needed).
            // holdCredits requires a real jobs row (FK) and is not appropriate here.
            const spent = spendCredits(userId, 1, `Cache hit unlock Stage 1 for @${username}`);
            if (!spent) {
              return NextResponse.json({
                error: "Failed to deduct credits",
                balance: currentBalance.balance,
              }, { status: 500 });
            }
            recordStageUnlock(userId, account.account_id, 1, "cache-hit-paid");
            recordApiCall("cache/unlock", true); // saved: tweets already in DB

            console.log(`[unlock] Paid cache hit for @${username} Stage 1: ${cachedCount} tweets, 1 credit consumed`);
            
            return NextResponse.json({
              jobId: null,
              status: "cache-hit",
              stage: 1,
              accountId: account.account_id,
              cachedCount,
              freeReUnlock: false,
              creditConsumed: true,
            });
          }
        }
      }
    } else {
      console.log(`[unlock] force=true or Stage ${requestedStage} for @${username} — skipping cache, creating new excavation job`);
    }

    // ── Check credit balance for new excavation ──
    const creditBalance = getCreditBalance(userId);
    if (creditBalance.balance < 1) {
      return NextResponse.json({
        error: "Insufficient credits",
        balance: creditBalance.balance,
        required: 1,
      }, { status: 402 });
    }

    // ── Stage-specific prerequisite and duplicate checking ──
    if (requestedStage > 1) {
      // Check if user already has this stage unlocked
      const account = getAccountByUsername(username);
      if (account && hasUserUnlockedStage(userId, account.account_id, requestedStage)) {
        return NextResponse.json({
          error: `You already have Stage ${requestedStage} unlocked for @${username}`,
          stage: requestedStage,
          alreadyUnlocked: true,
        }, { status: 400 });
      }
    }

    // ── Idempotency: collapse into existing active job (skipped when force=true) ──
    if (!force) {
      const activeJobId = findActiveJobForUsername(username);
      if (activeJobId) {
        console.log(`[unlock] Attaching to existing job ${activeJobId} for @${username} Stage ${requestedStage}`);
        return NextResponse.json({
          jobId: activeJobId,
          status: "attached",
          stage: requestedStage,
          creditConsumed: false, // Credit was already held by original request
        }, { status: 202 });
      }
    }

    // ── Hold credit and create new excavation job ──
    let jobId: string;
    
    if (requestedStage === 1) {
      // Stage 1: Use normal job creation
      const knownAccount = getAccountByUsername(username);
      jobId = createAndRunJob(username, knownAccount?.created_at, undefined, 1, force);
    } else {
      // Stage 2+: Use expansion job creation with prerequisite checking
      const expansionResult = createStageExpansionJob(username, requestedStage);
      if (expansionResult.error) {
        return NextResponse.json({
          error: expansionResult.error,
          stage: requestedStage,
        }, { status: 400 });
      }
      jobId = expansionResult.jobId!; // We know it exists since no error
    }
    
    const holdId = holdCredits(userId, jobId, 1);
    
    if (!holdId) {
      // This shouldn't happen since we checked balance, but be safe
      return NextResponse.json({
        error: "Failed to hold credits",
        balance: getCreditBalance(userId).balance,
      }, { status: 500 });
    }

    console.log(`[unlock] Created job ${jobId} for @${username} Stage ${requestedStage}, held 1 credit (${holdId})`);
    
    return NextResponse.json({
      jobId,
      status: "queued",
      stage: requestedStage,
      holdId,
      creditHeld: true,
    }, { status: 202 });
    
  } catch (error) {
    console.error('[unlock] Unexpected error:', error);
    return NextResponse.json({
      error: "Internal server error",
      message: error instanceof Error ? error.message : "Unknown error"
    }, { status: 500 });
  }
  }, mCtx); // withDevMeasure
}