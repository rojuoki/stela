import { NextRequest, NextResponse } from "next/server";
import { getCheckoutSessionPg } from "@/lib/repository";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const sessionId = searchParams.get('session_id');
    
    console.log("[guest-unlock/session] Token request for session:", sessionId);
    
    if (!sessionId) {
      console.log("[guest-unlock/session] Missing session_id parameter");
      return NextResponse.json({ error: "Missing session_id parameter" }, { status: 400 });
    }
    
    const session = await getCheckoutSessionPg(sessionId);
    
    if (!session) {
      console.log("[guest-unlock/session] Session not found or expired:", sessionId);
      return NextResponse.json({ error: "Session not found or expired" }, { status: 404 });
    }
    
    console.log(`[guest-unlock/session] Token found: ${session.unlock_token} for @${session.username}`);
    
    return NextResponse.json({ 
      token: session.unlock_token,
      username: session.username 
    });
    
  } catch (error) {
    console.error("[guest-unlock/session] Error retrieving token:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}