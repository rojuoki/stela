import { NextRequest } from "next/server";

const DEV_PANEL = process.env.NEXT_PUBLIC_DEV_PANEL === "1";

/**
 * Returns the effective user ID for a request.
 * - In production (DEV_PANEL off): always "anonymous"
 * - In dev (DEV_PANEL on): reads x-stela-user header, sanitizes it, falls back to "guest"
 */
export function getUserId(req: NextRequest): string {
  if (!DEV_PANEL) return "anonymous";
  const raw = req.headers.get("x-stela-user") ?? "";
  const sanitized = raw.match(/^[a-zA-Z0-9_-]{1,32}$/)?.[0];
  return sanitized ?? "guest";
}
