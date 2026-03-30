import { NextRequest, NextResponse } from "next/server";
import { getUserId } from "@/lib/getUserId";
import { hasUserUnlockedAccountPg, getAccountByUsernamePg, getTemporaryUnlockPg, transferTemporaryUnlockPg } from "@/lib/repository";
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
      const account = await getAccountByUsernamePg(username);
      if (!account) {
        return NextResponse.json({
          unlocked: false,
          reason: "account_not_found"
        });
      }

      // Check for temporary unlock first (guest purchases)
      let hasTemporaryUnlock = false;
      const tempUnlockToken = req.cookies.get('temp-unlock-token')?.value;
      
      if (tempUnlockToken) {
        const tempUnlock = await getTemporaryUnlockPg(tempUnlockToken);
        if (tempUnlock && tempUnlock.username.toLowerCase() === username.toLowerCase()) {
          hasTemporaryUnlock = true;
          
          // If user is authenticated, transfer the temporary unlock to their account
          if (userId !== "anonymous") {
            try {
              const transferred = await transferTemporaryUnlockPg(tempUnlockToken, userId);
              if (transferred) {
                console.log(`[unlock-status] Transferred temporary unlock to user ${userId} for ${username}`);
                // Clear the temporary unlock cookie since it's now transferred
                const response = NextResponse.json({
                  unlocked: true,
                  authenticated: true,
                  accountId: account.account_id,
                  transferred: true
                });
                response.cookies.delete('temp-unlock-token');
                return response;
              }
            } catch (error) {
              console.error(`[unlock-status] Failed to transfer temporary unlock:`, error);
            }
          } else {
            // Guest user with valid temporary unlock
            return NextResponse.json({
              unlocked: true,
              authenticated: false,
              accountId: account.account_id,
              temporary: true
            });
          }
        }
      }

      // Check unlock status for authenticated users
      if (userId === "anonymous") {
        return NextResponse.json({
          unlocked: false,
          authenticated: false
        });
      }

      const isUnlocked = await hasUserUnlockedAccountPg(userId, account.account_id);

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