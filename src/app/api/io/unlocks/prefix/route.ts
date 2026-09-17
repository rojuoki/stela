import { NextRequest, NextResponse } from "next/server";
import { getIoUserFromRequest } from "@/lib/io/auth";
import { requestIoPrefixUnlock } from "@/lib/io/prefix-service";
import { normalizeIoUsername } from "@/lib/io/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const user = await getIoUserFromRequest(request);
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const username = normalizeIoUsername(body.username);
  if (!username) return NextResponse.json({ error: "Invalid username" }, { status: 400 });
  try {
    const result = await requestIoPrefixUnlock({ userId: user.id, username });
    return NextResponse.json(result, { status: result.kind === "queued" ? 202 : 200 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not plan prefix unlock" },
      { status: 409 },
    );
  }
}
