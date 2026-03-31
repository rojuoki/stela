/**
 * Dev-only API: /api/dev/unlocks
 * Requires NEXT_PUBLIC_DEV_PANEL=1.
 *
 * GET  → list all unlock records for the active dev user
 * DELETE ?username=<name> → reset one unlock
 * DELETE (no params)      → reset ALL unlocks
 */

import { NextRequest, NextResponse } from "next/server";
import {
  getDevUnlocksPg,
  deleteDevUnlockPg,
  deleteAllDevUnlocksPg,
  getAccountByUsernamePg,
} from "@/lib/repository";

const DEV_USER_ID = "anonymous"; // mirrors the rest of Phase 6

function guardDev(): NextResponse | null {
  if (process.env.NEXT_PUBLIC_DEV_PANEL !== "1") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return null;
}

export async function GET() {
  const block = guardDev();
  if (block) return block;

  try {
    const unlocks = await getDevUnlocksPg(DEV_USER_ID);
    return NextResponse.json({ userId: DEV_USER_ID, unlocks });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "unknown";
    console.error("[dev/unlocks] GET error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const block = guardDev();
  if (block) return block;

  try {
    const { searchParams } = new URL(req.url);
    const username = searchParams.get("username");

    if (username) {
      // Reset a single unlock by username
      const account = await getAccountByUsernamePg(username);
      if (!account) {
        return NextResponse.json(
          { error: `Account not found: ${username}` },
          { status: 404 }
        );
      }
      const deleted = await deleteDevUnlockPg(DEV_USER_ID, account.account_id);
      console.log(`[dev/unlocks] reset userId=${DEV_USER_ID} username=${username} (deleted=${deleted})`);
      return NextResponse.json({ ok: true, reset: username, deleted });
    }

    // Reset ALL unlocks for this dev user
    const deleted = await deleteAllDevUnlocksPg(DEV_USER_ID);
    console.log(`[dev/unlocks] reset ALL userId=${DEV_USER_ID} (deleted=${deleted})`);
    return NextResponse.json({ ok: true, reset: "all", deleted });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "unknown";
    console.error("[dev/unlocks] DELETE error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
