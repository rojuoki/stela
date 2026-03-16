import { NextRequest, NextResponse } from "next/server";
import { createAndRunJob } from "@/lib/jobs";
import { 
  getAccountByUsername, 
  getTweetsByAccount, 
  createTemporaryUnlock,
  cleanupExpiredTemporaryUnlocks,
  findActiveJobForUsername 
} from "@/lib/repository";
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
    cleanupExpiredTemporaryUnlocks();

    // Simulate successful one-time purchase (no Stripe yet)
    const paymentSuccessful = true; // In real implementation, this would come from Stripe
    
    if (!paymentSuccessful) {
      return NextResponse.json({ 
        error: "Payment failed" 
      }, { status: 402 });
    }

    // Check if account exists and has cached data
    const account = getAccountByUsername(normalizedUsername);
    
    if (account) {
      // Account exists - check for protected status
      if (account.protected) {
        return NextResponse.json({ 
          error: "This account is protected and cannot be excavated" 
        }, { status: 403 });
      }

      // Check for existing cached tweets
      const tweets = getTweetsByAccount(account.account_id);
      
      if (tweets.length > 0) {
        // Path 3: Cached result already exists - use it immediately
        const token = createTemporaryUnlock(account.account_id, normalizedUsername, tweets);
        console.log(`[purchase/guest-unlock] Using cached data for @${normalizedUsername}: ${token}`);
        
        return NextResponse.json({
          success: true,
          resultToken: token,
          source: "cached",
          message: "Using existing excavated data"
        });
      }
    }

    // Path 4: No cache exists - start excavation and create placeholder result
    console.log(`[purchase/guest-unlock] No cached data for @${normalizedUsername}, starting excavation`);

    // Check for existing active job to avoid duplicates
    let jobId = findActiveJobForUsername(normalizedUsername);
    
    if (!jobId) {
      // Start new excavation job
      jobId = createAndRunJob(
        normalizedUsername, 
        account?.created_at, 
        undefined, // no credit hold for guest purchases
        1, // stage 1
        false // not forced
      );
      console.log(`[purchase/guest-unlock] Started excavation job ${jobId} for @${normalizedUsername}`);
    } else {
      console.log(`[purchase/guest-unlock] Using existing active job ${jobId} for @${normalizedUsername}`);
    }

    // Create a temporary unlock with placeholder content that indicates excavation is in progress
    const placeholderAccountId = account?.account_id || `pending_${normalizedUsername}_${Date.now()}`;
    const placeholderTweets = [{
      post_id: `excavating_${Date.now()}`,
      account_id: placeholderAccountId,
      created_at: new Date().toISOString(),
      full_text: `🔄 Excavation in progress for @${normalizedUsername}. Your earliest posts will appear here shortly. Thank you for your purchase!`,
      media_json: null,
      like_count: 0,
      retweet_count: 0,
      reply_count: 0,
      fetched_at: new Date().toISOString()
    }];

    const token = createTemporaryUnlock(placeholderAccountId, normalizedUsername, placeholderTweets);
    console.log(`[purchase/guest-unlock] Created pending result token for @${normalizedUsername}: ${token} (job: ${jobId})`);

    return NextResponse.json({
      success: true,
      resultToken: token,
      jobId,
      source: "excavation_started",
      message: "Payment successful - excavation started"
    });

  } catch (error) {
    console.error('[purchase/guest-unlock] Error:', error);
    return NextResponse.json({
      error: "Internal server error",
    }, { status: 500 });
  }
}