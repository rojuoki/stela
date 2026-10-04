import { NextRequest, NextResponse } from "next/server";
import { getOrFetchIoProfile, IoProfileError } from "@/lib/io/profile";
import { requestIoPublicPreview } from "@/lib/io/public-preview";
import { normalizeIoUsername } from "@/lib/io/validation";
import { wakeIoWorker } from "@/lib/io/worker-wake";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const username = normalizeIoUsername(body.username);
  if (!username) return NextResponse.json({ error: "Invalid username" }, { status: 400 });
  try {
    const account = await getOrFetchIoProfile(username);
    if (account.protected) {
      return NextResponse.json({ error: "Posts from private accounts cannot be fetched." }, { status: 409 });
    }
    const result = await requestIoPublicPreview(account.username);
    if (result.kind === "queued") {
      void wakeIoWorker("public_preview");
    }
    return NextResponse.json(result, { status: result.kind === "queued" ? 202 : 200 });
  } catch (error) {
    if (error instanceof IoProfileError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Couldn’t prepare the free preview" },
      { status: 409 },
    );
  }
}
