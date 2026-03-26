import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { createOrUpdateSubscription, getUserSubscription, getUserPlan, grantMonthlyCredits } from "@/lib/repository";

const DEV_PANEL = process.env.NEXT_PUBLIC_DEV_PANEL === "1";

export async function POST(req: NextRequest) {
  if (!DEV_PANEL) {
    return NextResponse.json({ error: "Dev panel not enabled" }, { status: 404 });
  }

  try {
    const user = await getUserFromRequest(req);
    
    if (!user) {
      return NextResponse.json(
        { error: "Not authenticated" },
        { status: 401 }
      );
    }

    const body = await req.json();
    const { action, plan = 'basic', creditsPerCycle = 4 } = body;

    if (action === 'create') {
      const subscription = createOrUpdateSubscription(user.id, plan, creditsPerCycle);
      
      return NextResponse.json({
        success: true,
        subscription,
        message: `Created ${plan} subscription with ${creditsPerCycle} credits per cycle`
      });
    }

    if (action === 'grant-monthly') {
      const result = grantMonthlyCredits();
      return NextResponse.json({
        success: true,
        ...result,
        message: `Processed ${result.processed} subscriptions, granted ${result.granted} credits`
      });
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });

  } catch (error) {
    console.error("[dev/subscription] Error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

export async function GET(req: NextRequest) {
  if (!DEV_PANEL) {
    return NextResponse.json({ error: "Dev panel not enabled" }, { status: 404 });
  }

  try {
    const user = await getUserFromRequest(req);
    
    if (!user) {
      return NextResponse.json(
        { error: "Not authenticated" },
        { status: 401 }
      );
    }

    const subscription = getUserSubscription(user.id);
    const plan = getUserPlan(user.id);

    return NextResponse.json({
      userId: user.id,
      currentPlan: plan,
      subscription,
    });

  } catch (error) {
    console.error("[dev/subscription] Error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}