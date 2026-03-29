import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { giveCredits } from "@/lib/repository";

export async function POST(req: NextRequest) {
  try {
    const user = await getUserFromRequest(req);
    
    if (!user) {
      return NextResponse.json(
        { error: "Not authenticated" },
        { status: 401 }
      );
    }

    // TODO: Phase 4 - Integrate with Stripe for actual payment processing
    // For now, this is a placeholder that grants credits without payment
    
    // Placeholder payment simulation
    const paymentSuccessful = true; // In real implementation, this would come from Stripe webhook
    
    if (!paymentSuccessful) {
      return NextResponse.json(
        { error: "Payment failed" },
        { status: 402 }
      );
    }

    // Grant the credit
    giveCredits(user.id, 1, "Single unlock purchase ($4)");

    console.log(`[purchase] Single unlock purchased by ${user.email} (${user.id})`);

    return NextResponse.json({
      success: true,
      creditsGranted: 1,
      message: "Unlock purchased successfully",
    });

  } catch (error) {
    console.error("[purchase/unlock] Error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}