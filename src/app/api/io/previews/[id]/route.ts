import { NextResponse } from "next/server";
import { getIoPublicPreviewRun } from "@/lib/io/public-preview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const run = await getIoPublicPreviewRun((await params).id);
  return run
    ? NextResponse.json({ run })
    : NextResponse.json({ error: "Run not found" }, { status: 404 });
}
