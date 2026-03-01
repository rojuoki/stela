import { NextRequest, NextResponse } from "next/server";
import { sanitizeDevUserId, devResetUser } from "@/lib/devOps";

const DEV_PANEL = process.env.NEXT_PUBLIC_DEV_PANEL === "1";

export async function POST(req: NextRequest) {
  if (!DEV_PANEL) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const userId = sanitizeDevUserId(body.userId);
  if (!userId) return NextResponse.json({ error: "Invalid userId" }, { status: 400 });

  const deleted = devResetUser(userId);
  console.log(`[dev] resetUser userId=${userId} deleted=${deleted}`);
  return NextResponse.json({ ok: true, userId, deleted });
}
