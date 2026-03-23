import { NextRequest, NextResponse } from "next/server";
import { getTweetsByAccountUpToBoundary, getUserBoundaryEnd } from "@/lib/repository";
import { getUserId } from "@/lib/getUserId";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ accountId: string }> },
) {
  const { accountId } = await params;

  if (!accountId) {
    return NextResponse.json({ error: "accountId is required" }, { status: 400 });
  }

  // Get user context to determine their visibility boundary
  const userId = await getUserId(req);
  
  // Get user's boundary for this account
  const userBoundary = getUserBoundaryEnd(userId, accountId);
  
  if (userBoundary === 0) {
    // User hasn't unlocked this account
    return NextResponse.json({ tweets: [] });
  }

  // Return tweets up to user's boundary
  const tweets = getTweetsByAccountUpToBoundary(accountId, userBoundary);
  return NextResponse.json({ tweets });
}
