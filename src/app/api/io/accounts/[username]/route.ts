import { NextResponse } from "next/server";
import {
  countIoPostsForAccount,
  getIoAccountByUsername,
  getLatestIoRun,
} from "@/lib/io/repository";
import { normalizeIoUsername } from "@/lib/io/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ username: string }> },
) {
  const username = normalizeIoUsername((await params).username);
  if (!username) {
    return NextResponse.json({ error: "Invalid username" }, { status: 400 });
  }
  const account = getIoAccountByUsername(username);
  if (!account) {
    return NextResponse.json(
      { error: "Account not found in local IO database", latestRun: getLatestIoRun(username) },
      { status: 404 },
    );
  }
  return NextResponse.json({
    account,
    counts: {
      stored: countIoPostsForAccount(account.account_id),
      covered: countIoPostsForAccount(account.account_id, { coveredOnly: true }),
    },
    latestRun: getLatestIoRun(username),
  });
}
