import { NextRequest, NextResponse } from "next/server";
import { normalizeUsername, checkRateLimit } from "@/lib/validation";
import { getAccountByUsername, recordApiCall } from "@/lib/repository";
import { getUserByUsername, createStats, XApiStop } from "@/lib/xclient";
import { getDb } from "@/lib/db";
import { withDevMeasure, type MeasureCtx } from "@/lib/devMeasure";

export async function GET(req: NextRequest) {
  const rawUsername = new URL(req.url).searchParams.get("username");
  const mCtx: MeasureCtx = { route: "/api/account", username: rawUsername ?? undefined };
  return withDevMeasure("lookup", async () => {
    try {
    // Rate limiting
    const clientIp = req.headers.get("x-forwarded-for") || 
                     req.headers.get("x-real-ip") || 
                     "unknown";
    const rateCheck = checkRateLimit(clientIp);
    
    if (!rateCheck.allowed) {
      return NextResponse.json(
        { 
          error: "Too many requests", 
          retryAfter: Math.ceil((rateCheck.resetTime - Date.now()) / 1000)
        }, 
        { 
          status: 429,
          headers: {
            "Retry-After": String(Math.ceil((rateCheck.resetTime - Date.now()) / 1000)),
            "X-RateLimit-Remaining": "0",
            "X-RateLimit-Reset": String(Math.floor(rateCheck.resetTime / 1000)),
          }
        }
      );
    }

    const { searchParams } = new URL(req.url);
    const rawUsername = searchParams.get("username");

    // Input validation — guard null before passing to normalizeUsername
    if (!rawUsername) {
      return NextResponse.json({
        error: "Invalid username format. Must be 1-15 characters, letters/numbers/underscore only."
      }, { status: 400 });
    }
    const username = normalizeUsername(rawUsername);
    if (!username) {
      return NextResponse.json({ 
        error: "Invalid username format. Must be 1-15 characters, letters/numbers/underscore only." 
      }, { status: 400 });
    }

    // ── Check DB cache first ──
    const cachedAccount = getAccountByUsername(username);
    if (cachedAccount) {
      recordApiCall("cache/account", true); // saved: user lookup from DB
      console.log(`[account] Cache hit for @${username}`);
      return NextResponse.json({
        account_id: cachedAccount.account_id,
        username: cachedAccount.username,
        display_name: cachedAccount.display_name,
        avatar_url: cachedAccount.avatar_url,
        description: cachedAccount.description,
        created_at: cachedAccount.created_at,
        protected: cachedAccount.protected === 1,
        source: "cache",
        fetched_at: cachedAccount.fetched_at
      });
    }

    // ── Fetch from X API ──
    console.log(`[account] Fetching @${username} from X API`);
    const stats = createStats();
    
    try {
      const user = await getUserByUsername(username, stats);
      
      // Store in DB for future cache hits
      const db = getDb();
      db.prepare(`
        INSERT OR REPLACE INTO accounts (account_id, username, display_name, avatar_url, description, created_at, protected, fetched_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        user.id,
        user.username.toLowerCase(),
        user.name,
        user.profile_image_url || null,
        user.description || null,
        user.created_at,
        user.protected ? 1 : 0,
        new Date().toISOString()
      );

      console.log(`[account] Stored @${username} in cache`);
      
      return NextResponse.json({
        account_id: user.id,
        username: user.username,
        display_name: user.name,
        avatar_url: user.profile_image_url || null,
        description: user.description || null,
        created_at: user.created_at,
        protected: user.protected,
        source: "api",
        fetched_at: new Date().toISOString()
      });

    } catch (error) {
      if (error instanceof XApiStop) {
        // Return appropriate error based on X API response
        switch (error.reason) {
          case "PROTECTED_OR_SUSPENDED_OR_NOT_FOUND":
            return NextResponse.json({
              error: "Account not found, suspended, or protected",
              code: "NOT_FOUND"
            }, { status: 404 });
          case "RATE_LIMIT":
            return NextResponse.json({
              error: "X API rate limit exceeded",
              code: "RATE_LIMIT"
            }, { status: 429 });
          case "API_ERROR":
          default:
            return NextResponse.json({
              error: "X API error occurred",
              code: "API_ERROR"
            }, { status: 503 });
        }
      }
      
      throw error; // Re-throw unexpected errors
    }

    } catch (error) {
      console.error('[account] Unexpected error:', error);
      return NextResponse.json({
        error: "Internal server error",
        message: error instanceof Error ? error.message : "Unknown error"
      }, { status: 500 });
    }
  }, mCtx); // withDevMeasure
}