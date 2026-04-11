import { NextRequest, NextResponse } from "next/server";
import { createAndRunJob } from "@/lib/jobs";
import { 
  getAccountByUsernamePg, 
  getTweetsByAccountForGuestPg, 
  createTemporaryUnlockPg,
  cleanupExpiredTemporaryUnlocksPg,
  findActiveJobForUsername 
} from "@/lib/repository";
import { planGuestUnlock } from "@/lib/unlockPlanning";
import { normalizeUsername } from "@/lib/validation";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { username, returnUrl } = body;

    // Validate input
    const normalizedUsername = normalizeUsername(username);
    if (!normalizedUsername) {
      return NextResponse.json({ 
        error: "Invalid username format" 
      }, { status: 400 });
    }

    console.log(`[purchase/guest-unlock] Processing guest paid unlock for @${normalizedUsername}`);

    // Clean up expired temporary unlocks
    await cleanupExpiredTemporaryUnlocksPg();

    // Simulate successful one-time purchase (no Stripe yet)
    const paymentSuccessful = true; // In real implementation, this would come from Stripe
    
    if (!paymentSuccessful) {
      return NextResponse.json({ 
        error: "Payment failed" 
      }, { status: 402 });
    }

    // Check if account exists and plan guest unlock
    const account = await getAccountByUsernamePg(normalizedUsername);
    
    if (account) {
      // Account exists - check for protected status
      if (account.protected) {
        return NextResponse.json({ 
          error: "This account is protected and cannot be excavated" 
        }, { status: 403 });
      }

      // Use enhanced guest planning logic
      console.log(`[purchase/guest-unlock] Account found: account_id=${account.account_id}, username=${account.username}, created_at=${account.created_at}`);
      const plan = await planGuestUnlock(account.account_id, account.created_at);
      
      console.log(`[purchase/guest-unlock] Planning result for @${normalizedUsername} (account_id=${account.account_id}): target=${plan.targetCount}, cached=${plan.currentCachedCount}, missing=${plan.missingCount}, mode=${plan.executionMode}, boundary=${plan.guestBoundary}`);
      
      if (plan.executionMode === "cache_only") {
        // Cache-only path: sufficient tweets already available
        const tweets = await getTweetsByAccountForGuestPg(account.account_id, plan.guestBoundary);
        const token = await createTemporaryUnlockPg(account.account_id, normalizedUsername, tweets);
        console.log(`[purchase/guest-unlock] Cache-only for @${normalizedUsername}: ${token} (boundary=${plan.guestBoundary}, ${tweets.length} tweets)`);
        
        const response = NextResponse.json({
          success: true,
          resultToken: token,
          source: "cached",
          message: "Using existing excavated data"
        });
        
        // Set cookie to track temporary unlock for potential login migration
        response.cookies.set('temp-unlock-token', token, {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'lax',
          maxAge: 48 * 60 * 60 // 48 hours (same as temporary unlock TTL)
        });
        
        return response;
      }
    }

    // Excavation path: insufficient cache, need to excavate more
    const plan = account 
      ? await planGuestUnlock(account.account_id, account.created_at)
      : { 
          targetCount: 100, 
          currentCachedCount: 0, 
          missingCount: 100, 
          executionMode: "full_excavation" as const,
          excavationTargetCount: 100,
          excavationContinueFrom: null,
          expectedFinalBoundary: 100
        };
    
    console.log(`[purchase/guest-unlock] ${plan.executionMode} needed for @${normalizedUsername}: missing=${plan.missingCount}, continue_from=${plan.excavationContinueFrom?.toISOString() ?? "earliest"}`);

    // Check for existing active job to avoid duplicates
    let jobId = await findActiveJobForUsername(normalizedUsername);
    
    if (!jobId) {
      // Choose excavation approach based on planning mode
      if (plan.executionMode === "partial_excavation") {
        // Import additional excavation function
        const { createAdditionalExcavationJob } = await import("@/lib/jobs");
        
        // Use continuation-based excavation for partial cache scenarios
        jobId = await createAdditionalExcavationJob(
          normalizedUsername,
          plan.targetCount, // target boundary
          plan.missingCount, // missing tweets count
          "anonymous" // guest user
        );
        
        if (jobId) {
          console.log(`[purchase/guest-unlock] Started partial excavation job ${jobId} for @${normalizedUsername} (continue from cached ${plan.currentCachedCount}, need ${plan.missingCount} more)`);
        } else {
          throw new Error("Failed to create additional excavation job");
        }
      } else {
        // Use normal excavation for full excavation scenarios
        jobId = await createAndRunJob(
          normalizedUsername, 
          account?.created_at, 
          undefined, // no credit hold for guest purchases
          1, // stage 1
          false, // not forced
          "anonymous" // guest users are anonymous
        );
        console.log(`[purchase/guest-unlock] Started full excavation job ${jobId} for @${normalizedUsername} (need ${plan.targetCount} tweets)`);
      }
    } else {
      console.log(`[purchase/guest-unlock] Using existing active job ${jobId} for @${normalizedUsername}`);
    }

    // Create a temporary unlock with enhanced placeholder content
    const placeholderAccountId = account?.account_id || `pending_${normalizedUsername}_${Date.now()}`;
    
    // Create enhanced placeholder message based on excavation mode
    let placeholderMessage: string;
    if (plan.executionMode === "partial_excavation") {
      placeholderMessage = `🔄 Continuation excavation in progress for @${normalizedUsername}. Found ${plan.currentCachedCount} cached tweets, excavating ${plan.missingCount} more. Your earliest posts will appear here shortly. Thank you for your purchase!`;
    } else {
      placeholderMessage = `🔄 Full excavation in progress for @${normalizedUsername}. Excavating up to ${plan.targetCount} earliest tweets. Your posts will appear here shortly. Thank you for your purchase!`;
    }
    
    const placeholderTweets = [{
      post_id: `excavating_${Date.now()}`,
      account_id: placeholderAccountId,
      created_at: new Date().toISOString(),
      full_text: placeholderMessage,
      media_json: null,
      like_count: 0,
      retweet_count: 0,
      reply_count: 0,
      fetched_at: new Date().toISOString()
    }];

    const token = await createTemporaryUnlockPg(placeholderAccountId, normalizedUsername, placeholderTweets, jobId);
    console.log(`[purchase/guest-unlock] Created pending result token for @${normalizedUsername}: ${token} (job: ${jobId}, mode: ${plan.executionMode})`);

    const response = NextResponse.json({
      success: true,
      resultToken: token,
      jobId,
      source: "excavation_started",
      executionMode: plan.executionMode,
      targetCount: plan.targetCount,
      currentCachedCount: plan.currentCachedCount,
      missingCount: plan.missingCount,
      message: `Payment successful - ${plan.executionMode} started`
    });
    
    // Set cookie to track temporary unlock for potential login migration
    response.cookies.set('temp-unlock-token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 48 * 60 * 60 // 48 hours (same as temporary unlock TTL)
    });
    
    return response;

  } catch (error) {
    console.error('[purchase/guest-unlock] Error:', error);
    return NextResponse.json({
      error: "Internal server error",
    }, { status: 500 });
  }
}