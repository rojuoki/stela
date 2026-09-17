import { NextRequest, NextResponse } from "next/server";
import { getIoUserFromRequest } from "@/lib/io/auth";
import { getIoRangeRequestForUser } from "@/lib/io/range-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getIoUserFromRequest(request);
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const rangeRequest = await getIoRangeRequestForUser((await params).id, user.id);
  return rangeRequest
    ? NextResponse.json({ rangeRequest })
    : NextResponse.json({ error: "Range request not found" }, { status: 404 });
}
