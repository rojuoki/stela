import { NextRequest, NextResponse } from "next/server";
import { getIoUserFromRequest } from "@/lib/io/auth";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const user = await getIoUserFromRequest(request);
  return user
    ? NextResponse.json({ user })
    : NextResponse.json({ error: "Not authenticated" }, { status: 401 });
}
