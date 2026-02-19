import { NextRequest, NextResponse } from "next/server";
import { createAndRunJob } from "@/lib/jobs";
import {
  getAccountByUsername,
  getCachedTweetCount,
  findActiveJobForUsername,
  hasUserUnlockedAccount,
  recordUnlock,
  getCreditBalance,
  holdCredits,
  captureHeld,
  giveCredits,
  cleanupExpiredHolds,
} from "@/lib/repository";
import { normalizeUsername, validateLimit, checkRateLimit } from "@/lib/validation";

export async function POST(req: NextRequest) {
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

    let body: { username?: string; limit?: number };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    // Input validation and normalization
    const username = normalizeUsername(body.username);
    if (!username) {
      return NextResponse.json({ 
        error: "Invalid username format. Must be 1-15 characters, letters/numbers/underscore only." 
      }, { status: 400 });
    }

    const limit = validateLimit(body.limit);
    const userId = "anonymous"; // For MVP, single anonymous user

    // Clean up expired holds and ensure user has starting credits
    cleanupExpiredHolds();
    const userBalance = getCreditBalance(userId);
    if (userBalance.total_earned === 0) {
      // First time user - give starting credits
      giveCredits(userId, 3, "Initial allocation");
    }

    // ── Cache check: if we already have tweets for this account ──
    const account = getAccountByUsername(username);
    if (account) {
      const cachedCount = getCachedTweetCount(account.account_id);
      if (cachedCount > 0) {
        const alreadyUnlocked = hasUserUnlockedAccount(userId, account.account_id);
        
        if (alreadyUnlocked) {
          // Free re-unlock for same user
          recordUnlock(userId, account.account_id, "cache-hit-free");
          console.log(`[unlock] Free cache hit for @${username}: ${cachedCount} tweets, user already unlocked`);
          
          return NextResponse.json({
            jobId: null,
            status: "cache-hit",
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
            }, { status: 402 }); // Payment Required
          }
          
          // Create a dummy hold and immediately capture for cache hit
          const holdId = holdCredits(userId, "cache-hit", 1);
          if (!holdId) {
            return NextResponse.json({
              error: "Failed to hold credits",
              balance: currentBalance.balance,
            }, { status: 500 });
          }
          
          captureHeld(holdId, `Cache hit unlock for @${username}`);
          recordUnlock(userId, account.account_id, "cache-hit-paid");
          
          console.log(`[unlock] Paid cache hit for @${username}: ${cachedCount} tweets, 1 credit consumed`);
          
          return NextResponse.json({
            jobId: null,
            status: "cache-hit",
            accountId: account.account_id,
            cachedCount,
            freeReUnlock: false,
            creditConsumed: true,
          });
        }
      }
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

    // ── Idempotency: collapse into existing active job ──
    const activeJobId = findActiveJobForUsername(username);
    if (activeJobId) {
      console.log(`[unlock] Attaching to existing job ${activeJobId} for @${username}`);
      return NextResponse.json({
        jobId: activeJobId,
        status: "attached",
        creditConsumed: false, // Credit was already held by original request
      }, { status: 202 });
    }

    // ── Hold credit for new excavation ──
    const jobId = createAndRunJob(username, limit);
    const holdId = holdCredits(userId, jobId, 1);
    
    if (!holdId) {
      // This shouldn't happen since we checked balance, but be safe
      return NextResponse.json({
        error: "Failed to hold credits",
        balance: getCreditBalance(userId).balance,
      }, { status: 500 });
    }

    console.log(`[unlock] Created job ${jobId} for @${username}, held 1 credit (${holdId})`);
    
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
}