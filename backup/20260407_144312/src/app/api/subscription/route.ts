import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { getUserSubscriptionPg, getUserPlanPg } from "@/lib/repository";

export async function GET(req: NextRequest) {
  try {
    const user = await getUserFromRequest(req);
    
    if (!user) {
      return NextResponse.json(
        { error: "Not authenticated" },
        { status: 401 }
      );
    }

    const subscription = await getUserSubscriptionPg(user.id);
    const plan = await getUserPlanPg(user.id);

    if (!subscription) {
      return NextResponse.json({
        plan: 'free',
        isActive: false,
      });
    }

    return NextResponse.json({
      plan: subscription.plan,
      isActive: subscription.status === 'active',
      cycleEnd: subscription.cycle_end,
      creditsPerCycle: subscription.credits_per_cycle,
    });

  } catch (error) {
    console.error("[subscription] Error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}