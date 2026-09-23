import { NextResponse } from "next/server";
/** The local SQLite acquisition entry point is retired after the product cutover. */
export async function POST() {
  return NextResponse.json({ error: "Use authenticated IO Unlock: /api/io/unlocks/prefix" }, { status: 410 });
}
