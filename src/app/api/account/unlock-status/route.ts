import { NextRequest, NextResponse } from "next/server";
import { getUserId } from "@/lib/getUserId";
import { hasUserUnlockedAccount, getAccountByUsername } from "@/lib/repository";
import { withDevMeasure } from "@/lib/devMeasure";

export async function GET(req: NextRequest) {
  const userId = await getUserId(req);
  return withDevMeasure("other", async () => {
    const { searchParams } = new URL(req.url);
    const username = searchParams.get('username');
    
    if (!username) {
      return NextResponse.json(
        { error: "Username parameter required" },
        { status: 400 }
      );
    }

    try {
      // Get account info
      const account = getAccountByUsername(username);
      if (!account) {
        return NextResponse.json({
          unlocked: false,
          reason: "account_not_found"
        });
      }

      // Check unlock status for authenticated users
      if (userId === "anonymous") {
        return NextResponse.json({
          unlocked: false,
          authenticated: false
        });
      }

      const isUnlocked = hasUserUnlockedAccount(userId, account.account_id);

      return NextResponse.json({
        unlocked: isUnlocked,
        authenticated: true,
        accountId: account.account_id,
      });

    } catch (error) {
      console.error("[account/unlock-status] Error:", error);
      return NextResponse.json(
        { error: "Failed to check unlock status" },
        { status: 500 }
      );
    }
  }, { userId, route: "/api/account/unlock-status" });
}