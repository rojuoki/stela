import { NextRequest, NextResponse } from "next/server";
import { getIoUserFromRequest } from "@/lib/io/auth";
import { ioProductModeEnabled } from "@/lib/io/product-mode";
import { cancelIoPgRunForUser, getIoPgRun, getIoPgRunForUser } from "@/lib/io/pg-runs";
import { getIoRun } from "@/lib/io/repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const id = (await params).id;
  if (ioProductModeEnabled()) {
    const user = await getIoUserFromRequest(request);
    if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    const run = await getIoPgRunForUser(id, user.id);
    if (run) return NextResponse.json({ run, shared: false });
    const shared = await getIoPgRun(id);
    if (shared && ["prefix_initial", "prefix_extend"].includes(shared.collection_mode)) {
      return NextResponse.json({
        shared: true,
        run: {
          id: shared.id,
          username: shared.username,
          status: shared.status,
          progress_message: shared.progress_message,
          request_count: shared.request_count,
          page_count: shared.page_count,
          unique_count: shared.unique_count,
          target_count: shared.target_count,
          error_message: shared.error_message,
        },
      });
    }
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }
  const run = getIoRun(id);
  return run
    ? NextResponse.json({ run })
    : NextResponse.json({ error: "Run not found" }, { status: 404 });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!ioProductModeEnabled()) {
    return NextResponse.json({ error: "Cancellation requires IO product mode" }, { status: 409 });
  }
  const user = await getIoUserFromRequest(request);
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const run = await cancelIoPgRunForUser((await params).id, user.id);
  return run
    ? NextResponse.json({ run })
    : NextResponse.json({ error: "Active run not found" }, { status: 404 });
}
