import { NextRequest, NextResponse } from "next/server";
import { excavateEarliest } from "@/lib/excavate";
import { getUserId } from "@/lib/getUserId";
import { maybeInjectDevError } from "@/lib/devError";

const DEV_PANEL = process.env.NEXT_PUBLIC_DEV_PANEL === "1";

export async function POST(req: NextRequest) {
  const injected = await maybeInjectDevError(req);
  if (injected) return injected;

  let body: { username?: string; limit?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const raw = body.username?.trim().replace(/^@/, "");
  if (!raw || raw.length === 0) {
    return NextResponse.json({ error: "username is required" }, { status: 400 });
  }

  // Basic username validation (X usernames: 1-15 alphanumeric + underscore)
  if (!/^[A-Za-z0-9_]{1,15}$/.test(raw)) {
    return NextResponse.json({ error: "Invalid username format" }, { status: 400 });
  }

  const limit = Math.min(Math.max(body.limit ?? 100, 1), 100);

  const userId = getUserId(req);
  if (DEV_PANEL) console.log(`[dev] user_id=${userId} POST /api/excavate/earliest username=${raw}`);

  try {
    const result = await excavateEarliest(raw, limit);
    return NextResponse.json(result);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    console.error("[excavate/earliest] Unhandled:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
