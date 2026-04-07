import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { upsertUnlockBoundary } from "@/lib/unlockWrite";
import { 
  getAccountByUsernamePg, 
  getTweetsByAccount, 
  createTemporaryUnlockPg,
  cleanupExpiredTemporaryUnlocksPg,
  spendCreditsPg,
  getCachedTweetCountPg,
} from "@/lib/repository";
import { computeTargetCount } from "@/lib/unlockPlanning";
import { normalizeUsername } from "@/lib/validation";

export async function POST(req: NextRequest) {
  try {
    const user = await getUserFromRequest(req);
    
    if (!user) {
      return NextResponse.json(
        { error: "Not authenticated" },
        { status: 401 }
      );
    }

    const body = await req.json();
    const { username } = body;

    // Validate input
    const normalizedUsername = normalizeUsername(username);
    if (!normalizedUsername) {
      return NextResponse.json({ 
        error: "Invalid username format" 
      }, { status: 400 });
    }

    // Clean up expired temporary unlocks
    await cleanupExpiredTemporaryUnlocksPg();

    // Check if account exists and has cached data
    const account = await getAccountByUsernamePg(normalizedUsername);
    if (!account) {
      return NextResponse.json({ 
        error: "Account not found or not yet excavated" 
      }, { status: 404 });
    }

    if (account.protected) {
      return NextResponse.json({ 
        error: "This account is protected and cannot be excavated" 
      }, { status: 403 });
    }

    // Spend credit (this will check balance and fail if insufficient)
    const spendResult = await spendCreditsPg(user.id, 1, `Unlock @${normalizedUsername}`);
    if (!spendResult) {
      return NextResponse.json({ 
        error: "Insufficient credits" 
      }, { status: 402 });
    }

    // Record the unlock in the official table
    const cachedCount = await getCachedTweetCountPg(account.account_id);
    const targetCount = computeTargetCount(account.created_at);
    const boundary = Math.min(targetCount, cachedCount);
    await upsertUnlockBoundary(user.id, account.account_id, boundary, `logged-in-unlock-${Date.now()}`);

    // Get cached tweets
    const tweets = await getTweetsByAccount(account.account_id);
    if (tweets.length === 0) {
      return NextResponse.json({ 
        error: "No cached data available for this account" 
      }, { status: 404 });
    }

    // Create temporary unlock for results page
    // This will be auto-transferred since user is logged in
    const token = await createTemporaryUnlockPg(account.account_id, normalizedUsername, tweets);

    console.log(`[unlock/logged-in] Created unlock token for @${normalizedUsername} by user ${user.id}: ${token}`);

    return NextResponse.json({
      success: true,
      resultToken: token,
      message: "Unlock created successfully"
    });

  } catch (error) {
    console.error('[unlock/logged-in] Error:', error);
    return NextResponse.json({
      error: "Internal server error",
    }, { status: 500 });
  }
}