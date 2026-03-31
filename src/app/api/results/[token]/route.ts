import { NextRequest, NextResponse } from "next/server";
import { getTemporaryUnlockPg, cleanupExpiredTemporaryUnlocksPg } from "@/lib/repository";

export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    
    if (!token) {
      return NextResponse.json({ error: "Token required" }, { status: 400 });
    }

    // Clean up expired unlocks first
    await cleanupExpiredTemporaryUnlocksPg();

    // Get the temporary unlock
    const tempUnlock = await getTemporaryUnlockPg(token);
    
    if (!tempUnlock) {
      return NextResponse.json({ 
        error: "Unlock not found or expired" 
      }, { status: 404 });
    }

    // Parse tweets JSON
    let tweets;
    try {
      tweets = JSON.parse(tempUnlock.tweets_json);
    } catch (err) {
      console.error('[results] Failed to parse tweets JSON:', err);
      return NextResponse.json({ 
        error: "Invalid data format" 
      }, { status: 500 });
    }

    // Check if this is placeholder data from guest unlock - if so, try to get real data
    const isPlaceholder = tweets.some((tweet: any) => 
      tweet.post_id?.startsWith('excavating_') || 
      tweet.full_text?.includes('🔄 Excavation in progress')
    );

    if (isPlaceholder) {
      // Try to get actual excavated data with proper boundary logic
      const { getAccountByUsernamePg, getTweetsByAccountForGuestPg } = await import("@/lib/repository");
      const { planGuestUnlock } = await import("@/lib/unlockPlanning");
      
      const account = await getAccountByUsernamePg(tempUnlock.username);
      if (account) {
        const plan = await planGuestUnlock(account.account_id, account.created_at);
        if (plan.strategy === "cache-only" && plan.guestBoundary) {
          // Real data is available - return it with proper boundary
          const actualTweets = await getTweetsByAccountForGuestPg(account.account_id, plan.guestBoundary);
          if (actualTweets.length > 0) {
            console.log(`[results] Found actual excavated data for ${tempUnlock.username}: ${actualTweets.length} tweets (boundary=${plan.guestBoundary})`);
            tweets = actualTweets;
          }
        }
      }
    }

    return NextResponse.json({
      token: tempUnlock.token,
      account_id: tempUnlock.account_id,
      username: tempUnlock.username,
      tweets,
      job_id: tempUnlock.job_id,
      created_at: tempUnlock.created_at,
      expires_at: tempUnlock.expires_at,
    });

  } catch (error) {
    console.error('[results] Error:', error);
    return NextResponse.json({
      error: "Internal server error",
    }, { status: 500 });
  }
}