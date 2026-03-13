import { NextRequest, NextResponse } from "next/server";
import { getUserId } from "@/lib/getUserId";
import { getDevUnlocks } from "@/lib/repository";
import { withDevMeasure } from "@/lib/devMeasure";

export async function GET(req: NextRequest) {
  const userId = await getUserId(req);
  return withDevMeasure("other", async () => {
    // Require authentication
    if (userId === "anonymous") {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 }
      );
    }

    try {
      const unlocks = getDevUnlocks(userId);
      
      return NextResponse.json({
        userId,
        unlocks,
        count: unlocks.length,
      });

    } catch (error) {
      console.error("[account/unlocks] Error:", error);
      return NextResponse.json(
        { error: "Failed to fetch unlocks" },
        { status: 500 }
      );
    }
  }, { userId, route: "/api/account/unlocks" });
}