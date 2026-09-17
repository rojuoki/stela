import { NextResponse } from "next/server";
import { startIoAcquisition } from "@/lib/io/jobs";
import { parseAcquisitionProvider } from "@/lib/io/providers";
import { normalizeIoUsername } from "@/lib/io/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const username = normalizeIoUsername(body.username);
  if (!username) {
    return NextResponse.json({ error: "Invalid username" }, { status: 400 });
  }
  const targetCount = Number(body.targetCount ?? 1000);
  if (targetCount !== 100 && targetCount !== 1000) {
    return NextResponse.json(
      { error: "Prototype targetCount must be 100 or 1000" },
      { status: 400 },
    );
  }
  const provider = parseAcquisitionProvider(body.provider ?? "twitterapi_io");
  if (!provider) {
    return NextResponse.json(
      { error: "Prototype provider must be twitterapi_io or twscrape" },
      { status: 400 },
    );
  }
  try {
    const result = startIoAcquisition(username, targetCount, provider);
    return NextResponse.json(result, { status: result.reused ? 200 : 202 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 409 },
    );
  }
}
