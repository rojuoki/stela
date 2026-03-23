/**
 * Unlock Status Endpoint
 * 
 * Provides current unlock boundary and extend availability for a user+account.
 * This powers the UI to show:
 * - "X posts unlocked" 
 * - Whether extend button should be available
 * - What the next boundary would be
 * 
 * CRITICAL: This is the ONLY source of unlock boundary info for UI.
 * Frontend must NEVER calculate boundaries itself or use cached total.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserId } from "@/lib/getUserId";
import { 
  calculateUnlockedBoundary, 
  planExtension, 
  validateExtendRequest 
} from "@/lib/unlockPlanning";
import { getAccountByUsername } from "@/lib/repository";
import { normalizeUsername } from "@/lib/validation";

export async function GET(req: NextRequest) {
  const userId = await getUserId(req);
  
  try {
    const { searchParams } = new URL(req.url);
    const username = normalizeUsername(searchParams.get("username") ?? "");
    
    if (!username) {
      return NextResponse.json({ 
        error: "Invalid username parameter" 
      }, { status: 400 });
    }

    // Find account
    const account = getAccountByUsername(username);
    if (!account) {
      return NextResponse.json({ 
        error: `Account @${username} not found` 
      }, { status: 404 });
    }

    // Calculate current unlocked boundary (authoritative)
    const currentBoundary = calculateUnlockedBoundary(userId, account.account_id);
    
    // Check if user has unlocked anything yet
    if (currentBoundary === 0) {
      return NextResponse.json({
        username: account.username,
        accountId: account.account_id,
        unlocked: false,
        boundary: {
          current: 0,
          next: 100,
        },
        canExtend: false,
        reason: "Must complete initial unlock first",
      });
    }

    // Plan potential extension
    const plan = planExtension(userId, account.account_id);
    
    // Check if extend is valid and possible
    const validationError = validateExtendRequest(userId, account.account_id);
    const canExtend = validationError === null;
    
    // Return comprehensive status
    return NextResponse.json({
      username: account.username,
      accountId: account.account_id,
      unlocked: true,
      boundary: {
        current: currentBoundary,
        next: plan.boundary.next,
        postsUnlockedText: `${currentBoundary} posts unlocked`,
        nextExtendText: `+100 more posts (${plan.boundary.next} total)`,
      },
      canExtend,
      extendInfo: canExtend ? {
        strategy: plan.strategy,
        requiresExcavation: plan.strategy === "excavation",
        cacheHit: plan.strategy === "cache-only",
        missingCount: plan.boundary.missingCount,
      } : null,
      reason: validationError,
    });

  } catch (error) {
    console.error('[unlock-status] Error:', error);
    return NextResponse.json({
      error: "Internal server error",
      message: error instanceof Error ? error.message : "Unknown error"
    }, { status: 500 });
  }
}