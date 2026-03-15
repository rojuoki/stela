import { NextRequest, NextResponse } from "next/server";
import { getTemporaryUnlock, cleanupExpiredTemporaryUnlocks } from "@/lib/repository";

export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    
    if (!token) {
      return NextResponse.json({ error: "Token required" }, { status: 400 });
    }

    // Clean up expired unlocks first
    cleanupExpiredTemporaryUnlocks();

    // Get the temporary unlock
    const tempUnlock = getTemporaryUnlock(token);
    
    if (!tempUnlock) {
      return NextResponse.json({ 
        error: "Unlock not found or expired" 
      }, { status: 404 });
    }

    // Parse tweets JSON
    let tweets;
    try {
      tweets = JSON.parse(tempUnlock.tweets_json);
    } catch (err) {
      console.error('[results] Failed to parse tweets JSON:', err);
      return NextResponse.json({ 
        error: "Invalid data format" 
      }, { status: 500 });
    }

    return NextResponse.json({
      token: tempUnlock.token,
      account_id: tempUnlock.account_id,
      username: tempUnlock.username,
      tweets,
      created_at: tempUnlock.created_at,
      expires_at: tempUnlock.expires_at,
    });

  } catch (error) {
    console.error('[results] Error:', error);
    return NextResponse.json({
      error: "Internal server error",
    }, { status: 500 });
  }
}