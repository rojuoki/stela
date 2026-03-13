import { NextResponse } from "next/server";
import { getSummary } from "@/lib/devStats";

const DEV_PANEL = process.env.NEXT_PUBLIC_DEV_PANEL === "1";

export async function GET() {
  if (!DEV_PANEL) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(getSummary());
}
