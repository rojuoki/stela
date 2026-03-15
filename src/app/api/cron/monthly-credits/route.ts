import { NextRequest, NextResponse } from "next/server";
import { grantMonthlyCredits } from "@/lib/repository";

export async function POST(req: NextRequest) {
  try {
    // Simple secret-based auth for cron jobs
    const authHeader = req.headers.get('authorization');
    const cronSecret = process.env.CRON_SECRET || 'stela-cron-secret';
    
    if (authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const result = grantMonthlyCredits();
    
    console.log(`[cron/monthly-credits] Completed: ${result.processed} subscriptions processed, ${result.granted} credits granted`);
    
    return NextResponse.json({
      success: true,
      ...result,
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    console.error("[cron/monthly-credits] Error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}