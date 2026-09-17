import { NextResponse } from "next/server";
import { createIoLogoutResponse } from "@/lib/io/auth";

export const runtime = "nodejs";

export async function POST() {
  return createIoLogoutResponse({ success: true });
}
