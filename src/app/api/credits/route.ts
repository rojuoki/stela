import { NextRequest, NextResponse } from "next/server";
import { getCreditBalance, cleanupExpiredHolds } from "@/lib/repository";

export async function GET(req: NextRequest) {
  const userId = "anonymous"; // Phase 6: using anonymous for now
  
  // Clean up expired holds
  cleanupExpiredHolds();
  
  const balance = getCreditBalance(userId);
  
  return NextResponse.json({
    userId,
    balance: balance.balance,
    totalEarned: balance.total_earned,
    totalSpent: balance.total_spent,
    updatedAt: balance.updated_at,
  });
}