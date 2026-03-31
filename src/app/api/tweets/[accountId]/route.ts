import { NextRequest, NextResponse } from "next/server";
import { getTweetsByAccountUpToBoundaryPg, getTweetsByAccountRangePg, getUserBoundaryEndPg } from "@/lib/repository";
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
  const userBoundary = await getUserBoundaryEndPg(userId, accountId);
  
  if (userBoundary === 0) {
    // User hasn't unlocked this account
    return NextResponse.json({ tweets: [] });
  }

  // Check for range parameters
  const url = new URL(req.url);
  const rangeStart = url.searchParams.get('rangeStart');
  const rangeEnd = url.searchParams.get('rangeEnd');

  if (rangeStart && rangeEnd) {
    // Range mode - return specific range
    const start = parseInt(rangeStart, 10);
    const end = parseInt(rangeEnd, 10);
    
    if (isNaN(start) || isNaN(end) || start < 1 || end < start) {
      return NextResponse.json({ error: "Invalid range parameters" }, { status: 400 });
    }
    
    // Ensure range doesn't exceed user's boundary
    if (end > userBoundary) {
      return NextResponse.json({ error: "Range exceeds user boundary" }, { status: 403 });
    }
    
    // Convert to 0-indexed offset and limit for database query
    const offset = start - 1;
    const limit = end - start + 1;
    
    const tweets = await getTweetsByAccountRangePg(accountId, offset, limit);
    return NextResponse.json({ tweets });
  }

  // Default behavior - return tweets up to user's boundary
  const tweets = await getTweetsByAccountUpToBoundaryPg(accountId, userBoundary);
  return NextResponse.json({ tweets });
}
