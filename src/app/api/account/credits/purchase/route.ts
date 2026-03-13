import { NextRequest, NextResponse } from "next/server";
import { getUserId } from "@/lib/getUserId";
import { giveCredits } from "@/lib/repository";
import { withDevMeasure } from "@/lib/devMeasure";

interface PurchaseRequest {
  amount: number;
  paymentMethod?: string; // For future Stripe integration
}

export async function POST(req: NextRequest) {
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
      const body: PurchaseRequest = await req.json();
      const { amount } = body;

      // Validate amount
      if (!amount || amount < 1 || amount > 100) {
        return NextResponse.json(
          { error: "Invalid credit amount. Must be between 1 and 100." },
          { status: 400 }
        );
      }

      // For Phase 4: Simple credit granting (no real payment processing)
      // In production, this would integrate with Stripe or other payment processor
      const reason = `Credit purchase - ${amount} credits`;
      giveCredits(userId, amount, reason);

      return NextResponse.json({
        success: true,
        creditsAdded: amount,
        message: `Successfully added ${amount} credits to your account`,
      });

    } catch (error) {
      console.error("[account/credits/purchase] Error:", error);
      return NextResponse.json(
        { error: "Failed to process credit purchase" },
        { status: 500 }
      );
    }
  }, { userId, route: "/api/account/credits/purchase" });
}