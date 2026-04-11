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

    if (isPlaceholder && tempUnlock.job_id) {
      // Check if the excavation job has completed
      const { getJobPg, getAccountByUsernamePg, getTweetsByAccountUpToBoundaryPg, getCachedTweetCountPg } = await import("@/lib/repository");
      const { computeTargetCount } = await import("@/lib/unlockPlanning");
      
      const job = await getJobPg(tempUnlock.job_id);
      if (job && job.status === 'succeeded' && job.result_json) {
        try {
          const excavationResult = JSON.parse(job.result_json);
          const account = await getAccountByUsernamePg(tempUnlock.username);
          
          if (account && excavationResult.accountId) {
            // Calculate final boundary using same logic as job completion
            const timelineExhausted = 
              excavationResult.timelineExhausted === true &&
              excavationResult.stopReason === "ACCOUNT_HAS_LESS_THAN_LIMIT";
            
            let finalBoundary: number;
            if (timelineExhausted) {
              // Timeline exhausted: use cache-based boundary
              const cachedCount = await getCachedTweetCountPg(excavationResult.accountId);
              const targetCount = computeTargetCount(account.created_at);
              finalBoundary = Math.min(targetCount, cachedCount);
              console.log(
                `[results] Timeline exhausted — cache-based boundary: cached=${cachedCount}, target=${targetCount}, finalBoundary=${finalBoundary}`,
              );
            } else {
              // Normal completion: use fetched count
              finalBoundary = excavationResult.fetchedCount;
              console.log(
                `[results] Normal completion — fetched boundary: fetchedCount=${excavationResult.fetchedCount}, finalBoundary=${finalBoundary}`,
              );
            }

            if (finalBoundary > 0) {
              // Get actual excavated tweets with proper boundary
              const actualTweets = await getTweetsByAccountUpToBoundaryPg(excavationResult.accountId, finalBoundary);
              if (actualTweets.length > 0) {
                console.log(
                  `[results] ✅ Job completed: ${tempUnlock.username} (job: ${tempUnlock.job_id}), ` +
                  `boundary=${finalBoundary}, tweets=${actualTweets.length}, timelineExhausted=${timelineExhausted}`
                );
                tweets = actualTweets;
              }
            }
          }
        } catch (parseError) {
          console.error(`[results] Failed to parse job result for ${tempUnlock.job_id}:`, parseError);
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