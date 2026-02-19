import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export function GET() {
  try {
    const db = getDb();
    const row = db.prepare("SELECT 1 AS ok").get() as { ok: number };
    return NextResponse.json({ status: "ok", db: row.ok === 1 });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "unknown";
    return NextResponse.json({ status: "error", error: msg }, { status: 500 });
  }
}
