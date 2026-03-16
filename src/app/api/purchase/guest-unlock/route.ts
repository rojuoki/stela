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

    // Path 4: No cache exists - create placeholder result for now
    console.log(`[purchase/guest-unlock] No cached data for @${normalizedUsername}, creating placeholder result`);

    // Create a temporary unlock with development/placeholder content
    // This ensures guest users get a valid /results/[token] page instead of 404
    const placeholderAccountId = `guest_${normalizedUsername}_${Date.now()}`;
    const placeholderTweets = [{
      post_id: `guest_${Date.now()}`,
      account_id: placeholderAccountId,
      created_at: new Date().toISOString(),
      full_text: `Thank you for your purchase! Excavation for @${normalizedUsername} will be available soon. This is a development preview.`,
      media_json: null,
      like_count: 0,
      retweet_count: 0,
      reply_count: 0,
      fetched_at: new Date().toISOString()
    }];

    const token = createTemporaryUnlock(placeholderAccountId, normalizedUsername, placeholderTweets);
    console.log(`[purchase/guest-unlock] Created guest result token for @${normalizedUsername}: ${token}`);

    return NextResponse.json({
      success: true,
      resultToken: token,
      source: "placeholder",
      message: "Payment successful - excavation feature coming soon"
    });

  } catch (error) {
    console.error('[purchase/guest-unlock] Error:', error);
    return NextResponse.json({
      error: "Internal server error",
    }, { status: 500 });
  }
}