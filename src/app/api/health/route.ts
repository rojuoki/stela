import { NextResponse } from "next/server";
import { getDatabaseHealthPg } from "@/lib/repository";

export async function GET() {
  try {
    const health = await getDatabaseHealthPg();
    return NextResponse.json({ 
      status: "ok", 
      db: health.healthy,
      postgres: true,
      value: health.dbValue
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "unknown";
    return NextResponse.json({ 
      status: "error", 
      error: msg,
      postgres: true
    }, { status: 500 });
  }
}
