import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { createOrUpdateSubscription } from "@/lib/repository";

export async function POST(req: NextRequest) {
  try {
    const user = await getUserFromRequest(req);
    
    if (!user) {
      return NextResponse.json(
        { error: "Not authenticated" },
        { status: 401 }
      );
    }

    const body = await req.json();
    const { plan = 'basic' } = body;

    if (plan !== 'basic') {
      return NextResponse.json(
        { error: "Invalid plan. Only 'basic' is currently supported." },
        { status: 400 }
      );
    }

    // TODO: Phase 4 - Integrate with Stripe for actual payment processing
    // For now, this is a placeholder that creates subscription without payment
    
    // Placeholder payment simulation
    const paymentSuccessful = true; // In real implementation, this would come from Stripe webhook
    
    if (!paymentSuccessful) {
      return NextResponse.json(
        { error: "Payment failed" },
        { status: 402 }
      );
    }

    // Create the subscription (this also grants initial credits)
    const subscription = createOrUpdateSubscription(user.id, 'basic', 4);

    console.log(`[subscription] Basic subscription created for ${user.email} (${user.id})`);

    return NextResponse.json({
      success: true,
      subscription: {
        id: subscription.id,
        plan: subscription.plan,
        cycleStart: subscription.cycle_start,
        cycleEnd: subscription.cycle_end,
        creditsPerCycle: subscription.credits_per_cycle,
        status: subscription.status,
      },
      creditsGranted: 4,
      message: "Subscription created successfully",
    });

  } catch (error) {
    console.error("[subscription/create] Error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}