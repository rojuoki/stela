import { NextRequest, NextResponse } from "next/server";
import { sanitizeDevUserId, sanitizeDevUsername, devForceUnlock } from "@/lib/devOps";

const DEV_PANEL = process.env.NEXT_PUBLIC_DEV_PANEL === "1";
const VALID_CAPS = new Set([50, 75, 100]);

export async function POST(req: NextRequest) {
  if (!DEV_PANEL) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const userId = sanitizeDevUserId(body.userId);
  if (!userId) return NextResponse.json({ error: "Invalid userId" }, { status: 400 });

  const username = sanitizeDevUsername(body.username);
  if (!username) return NextResponse.json({ error: "Invalid username" }, { status: 400 });

  const cap = Number(body.cap);
  if (!VALID_CAPS.has(cap)) return NextResponse.json({ error: "cap must be 50, 75, or 100" }, { status: 400 });

  devForceUnlock(userId, username, cap);
  console.log(`[dev] forceUnlock userId=${userId} username=${username} cap=${cap}`);
  return NextResponse.json({ ok: true, userId, username, cap });
}
