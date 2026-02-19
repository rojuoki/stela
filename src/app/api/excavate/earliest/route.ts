import { NextRequest, NextResponse } from "next/server";
import { excavateEarliest } from "@/lib/excavate";

export async function POST(req: NextRequest) {
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

  try {
    const result = await excavateEarliest(raw, limit);
    return NextResponse.json(result);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    console.error("[excavate/earliest] Unhandled:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
