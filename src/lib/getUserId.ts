import { NextRequest } from "next/server";
import { getUserFromRequest } from "./auth";

// Phase 2: Authentication integration complete

const DEV_PANEL = process.env.NEXT_PUBLIC_DEV_PANEL === "1";

/**
 * Returns the effective user ID for a request.
 * Phase 2: Full authentication integration
 * 1. Check for authenticated user via JWT token
 * 2. In dev mode (DEV_PANEL on): fall back to x-stela-user header for dev user switching  
 * 3. Final fallback: "anonymous" (for unauthenticated users)
 */
export async function getUserId(req: NextRequest): Promise<string> {
  try {
    // First priority: Check for authenticated user via JWT
    const user = await getUserFromRequest(req);
    if (user && user.id) {
      return user.id;
    }
  } catch (error) {
    // If authentication parsing fails, continue to fallback methods
    console.warn('[getUserId] Authentication parsing failed:', error);
  }

  // Second priority: In dev mode, check dev user switching header
  if (DEV_PANEL) {
    const raw = req.headers.get("x-stela-user") ?? "";
    const sanitized = raw.match(/^[a-zA-Z0-9_-]{1,32}$/)?.[0];
    if (sanitized) {
      return sanitized;
    }
  }

  // Final fallback: anonymous user (for guests and unauthenticated requests)
  return "anonymous";
}
