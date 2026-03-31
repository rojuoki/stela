import { NextRequest, NextResponse } from "next/server";
import { getCreditBalance, cleanupExpiredHoldsPg } from "@/lib/repository";
import { getUserId } from "@/lib/getUserId";
import { maybeInjectDevError } from "@/lib/devError";

const DEV_PANEL = process.env.NEXT_PUBLIC_DEV_PANEL === "1";

export async function GET(req: NextRequest) {
  const userId = await getUserId(req);
  const injected = await maybeInjectDevError(req);
  if (injected) return injected;

  if (DEV_PANEL) console.log(`[dev] user_id=${userId} GET /api/credits`);

  await cleanupExpiredHoldsPg();
  const balance = await getCreditBalance(userId);

  return NextResponse.json({
    userId,
    balance: balance.balance,
    totalEarned: balance.total_earned,
    totalSpent: balance.total_spent,
    updatedAt: balance.updated_at,
  });
}
