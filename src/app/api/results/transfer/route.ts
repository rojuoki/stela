import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { transferTemporaryUnlockPg } from "@/lib/repository";

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
    const { token } = body;

    if (!token) {
      return NextResponse.json({ 
        error: "Token required" 
      }, { status: 400 });
    }

    // Transfer the temporary unlock to the user's account
    const success = await transferTemporaryUnlockPg(token, user.id);
    
    if (!success) {
      return NextResponse.json({ 
        error: "Unlock not found, expired, or already transferred" 
      }, { status: 404 });
    }

    console.log(`[results/transfer] Successfully transferred token ${token} to user ${user.id}`);

    return NextResponse.json({
      success: true,
      message: "Unlock saved to your account",
    });

  } catch (error) {
    console.error('[results/transfer] Error:', error);
    return NextResponse.json({
      error: "Internal server error",
    }, { status: 500 });
  }
}