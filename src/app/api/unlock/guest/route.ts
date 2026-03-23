import { NextRequest, NextResponse } from "next/server";
import { 
  getAccountByUsername, 
  getTweetsByAccountForGuest, 
  createTemporaryUnlock,
  cleanupExpiredTemporaryUnlocks 
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

    // Clean up expired temporary unlocks
    cleanupExpiredTemporaryUnlocks();

    // Check if account exists
    const account = getAccountByUsername(normalizedUsername);
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

    // Use unified guest planning logic
    const plan = planGuestUnlock(account.account_id, account.created_at);
    
    if (plan.strategy !== "cache-only" || !plan.guestBoundary) {
      return NextResponse.json({ 
        error: "No sufficient cached data available for this account" 
      }, { status: 404 });
    }

    // Get tweets respecting guest boundary (follows same model as logged-in users)
    const tweets = getTweetsByAccountForGuest(account.account_id, plan.guestBoundary);
    if (tweets.length === 0) {
      return NextResponse.json({ 
        error: "No cached data available for this account" 
      }, { status: 404 });
    }

    console.log(`[unlock/guest] Guest plan for @${normalizedUsername}: boundary=${plan.guestBoundary}, cached=${plan.currentCachedCount}`);

    // Create temporary unlock
    const token = createTemporaryUnlock(account.account_id, normalizedUsername, tweets);

    // TODO: Phase 4 - Replace with actual Stripe Checkout
    // For now, return the token directly for development
    console.log(`[unlock/guest] Created temporary unlock for @${normalizedUsername}: ${token}`);

    // Development mode: skip payment
    if (process.env.NODE_ENV === 'development') {
      return NextResponse.json({
        success: true,
        resultToken: token,
        message: "Development mode: payment skipped"
      });
    }

    // Production: would redirect to Stripe Checkout
    return NextResponse.json({
      success: true,
      redirectUrl: `/checkout?token=${token}&return=${encodeURIComponent(returnUrl || '/')}`,
      message: "Redirecting to checkout"
    });

  } catch (error) {
    console.error('[unlock/guest] Error:', error);
    return NextResponse.json({
      error: "Internal server error",
    }, { status: 500 });
  }
}