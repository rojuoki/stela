import { NextRequest, NextResponse } from "next/server";
import { createAndRunJob } from "@/lib/jobs";
import { planInitialUnlockPg } from "@/lib/unlockPlanning";
import { upsertUnlockBoundary } from "@/lib/unlockWrite";
import {
  getAccountByUsernamePg,
  getCachedTweetCountPg,
  findActiveJobForUsernamePg,
  hasUserUnlockedAccountPg,
  getCreditBalancePg,
  holdCreditsPg,
  captureHeldPg,
  spendCreditsPg,
  giveCreditsPg,
  cleanupExpiredHoldsPg,
  recordApiCallPg,
} from "@/lib/repository";
import { normalizeUsername, checkRateLimit } from "@/lib/validation";
import { getUserId } from "@/lib/getUserId";
import { maybeInjectDevError } from "@/lib/devError";
import { withDevMeasure, type MeasureCtx } from "@/lib/devMeasure";

const DEV_PANEL = process.env.NEXT_PUBLIC_DEV_PANEL === "1";

export async function POST(req: NextRequest) {
  const userId = await getUserId(req);
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
    if (!username) {
      return NextResponse.json({ 
        error: "Invalid username format. Must be 1-15 characters, letters/numbers/underscore only." 
      }, { status: 400 });
    }

    // force=true bypasses cache and idempotency, always creates a new excavation job.
    // Credit rule: force=true always holds 1 credit (same as a fresh first-time unlock).
    const force = body.force === true;
    // Legacy: accept stage param but ignore for entitlement — boundary is source of truth
    const requestedStage = 1; // Always treated as initial unlock; extend handles subsequent
    if (DEV_PANEL) console.log(`[dev] user_id=${userId} POST /api/unlock username=${body.username}`);

    // Clean up expired holds and ensure user has starting credits
    await cleanupExpiredHoldsPg();
    const userBalance = await getCreditBalancePg(userId);
    if (userBalance.total_earned === 0) {
      // First time user - give starting credits
      await giveCreditsPg(userId, 3, "Initial allocation");
    }

    // ── Unified decision planning: cache-hit and fresh excavation use same logic ──
    const account = await getAccountByUsernamePg(username);
    const plan = await planInitialUnlockPg(userId, account?.account_id || null, requestedStage, account?.created_at || null);
    
    console.log(`[unlock] @${username} initial plan:`, {
      targetCount: plan.targetCount,
      currentCachedCount: plan.currentCachedCount,
      strategy: plan.strategy,
      force: force
    });

    // ── Cache-only path: sufficient posts already cached, not forced ──
    if (!force && plan.strategy === "cache-only" && account && plan.grantBoundary) {
      const alreadyUnlocked = await hasUserUnlockedAccountPg(userId, account.account_id);
      
      if (alreadyUnlocked) {
        // Free re-unlock for same user (already unlocked)
        await upsertUnlockBoundary(userId, account.account_id, plan.grantBoundary, "cache-hit-free");
        await recordApiCallPg("cache/unlock", true); // saved: no excavation needed
        console.log(`[unlock] Free cache hit for @${username}  ${plan.currentCachedCount} tweets, user already unlocked`);
        
        return NextResponse.json({
          jobId: null,
          status: "cache-hit",
          
          accountId: account.account_id,
          cachedCount: plan.currentCachedCount,
          freeReUnlock: true,
          creditConsumed: false,
        });
      } else {
        // First time unlock from cache - still consumes credit
        const currentBalance = await getCreditBalancePg(userId);
        if (currentBalance.balance < 1) {
          return NextResponse.json({
            error: "Insufficient credits",
            balance: currentBalance.balance,
            required: 1,
          }, { status: 402 });
        }
        
        // Cache-hit is synchronous — spend directly (no async job → no hold needed).
        const spent = await spendCreditsPg(userId, 1, `Cache hit unlock initial for @${username}`);
        if (!spent) {
          return NextResponse.json({
            error: "Failed to deduct credits",
            balance: currentBalance.balance,
          }, { status: 500 });
        }
        
        await upsertUnlockBoundary(userId, account.account_id, plan.grantBoundary, "cache-hit-paid");
        await recordApiCallPg("cache/unlock", true); // saved: tweets already in DB

        console.log(`[unlock] Paid cache hit for @${username}  ${plan.currentCachedCount} tweets, 1 credit consumed`);
        
        return NextResponse.json({
          jobId: null,
          status: "cache-hit",
          
          accountId: account.account_id,
          cachedCount: plan.currentCachedCount,
          freeReUnlock: false,
          creditConsumed: true,
        });
      }
    } else {
      console.log(`[unlock] force=${force} or excavation needed for @${username} initial — creating excavation job`);
    }

    // ── Check credit balance for new excavation ──
    const creditBalance = await getCreditBalancePg(userId);
    if (creditBalance.balance < 1) {
      return NextResponse.json({
        error: "Insufficient credits",
        balance: creditBalance.balance,
        required: 1,
      }, { status: 402 });
    }

    // ── Idempotency: collapse into existing active job (skipped when force=true) ──
    if (!force) {
      const activeJobId = await findActiveJobForUsernamePg(username);
      if (activeJobId) {
        console.log(`[unlock] Attaching to existing job ${activeJobId} for @${username}`);
        return NextResponse.json({
          jobId: activeJobId,
          status: "attached",
          creditConsumed: false,
        }, { status: 202 });
      }
    }

    // ── Hold credit and create new excavation job ──
    const jobId = await createAndRunJob(username, account?.created_at, undefined, 1, force, userId);
    
    const holdId = await holdCreditsPg(userId, jobId, 1);
    
    if (!holdId) {
      // This shouldn't happen since we checked balance, but be safe
      const currentBalance = await getCreditBalancePg(userId);
      return NextResponse.json({
        error: "Failed to hold credits",
        balance: currentBalance.balance,
      }, { status: 500 });
    }

    console.log(`[unlock] Created job ${jobId} for @${username} initial, held 1 credit (${holdId})`);
    
    return NextResponse.json({
      jobId,
      status: "queued",
      
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
  }, { userId, route: "/api/unlock" }); // withDevMeasure
}