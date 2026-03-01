import { NextResponse } from "next/server";
import { reset } from "@/lib/devStats";

const DEV_PANEL = process.env.NEXT_PUBLIC_DEV_PANEL === "1";

export async function POST() {
  if (!DEV_PANEL) return NextResponse.json({ error: "Not found" }, { status: 404 });
  reset();
  console.log("[dev] stats reset");
  return NextResponse.json({ ok: true });
}
