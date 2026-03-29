import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const sessionId = searchParams.get('session_id');
    
    console.log("[guest-unlock/session] Token request for session:", sessionId);
    
    if (!sessionId) {
      console.log("[guest-unlock/session] Missing session_id parameter");
      return NextResponse.json({ error: "Missing session_id parameter" }, { status: 400 });
    }
    
    const db = getDb();
    const row = db.prepare(`
      SELECT unlock_token, username FROM checkout_sessions 
      WHERE session_id = ? AND expires_at > ?
    `).get(sessionId, new Date().toISOString()) as { unlock_token: string, username: string } | undefined;
    
    if (!row) {
      console.log("[guest-unlock/session] Session not found or expired:", sessionId);
      return NextResponse.json({ error: "Session not found or expired" }, { status: 404 });
    }
    
    console.log(`[guest-unlock/session] Token found: ${row.unlock_token} for @${row.username}`);
    
    return NextResponse.json({ 
      token: row.unlock_token,
      username: row.username 
    });
    
  } catch (error) {
    console.error("[guest-unlock/session] Error retrieving token:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}