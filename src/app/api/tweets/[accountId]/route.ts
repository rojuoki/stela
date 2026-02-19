import { NextRequest, NextResponse } from "next/server";
import { getTweetsByAccount } from "@/lib/repository";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ accountId: string }> },
) {
  const { accountId } = await params;

  if (!accountId) {
    return NextResponse.json({ error: "accountId is required" }, { status: 400 });
  }

  const tweets = getTweetsByAccount(accountId);
  return NextResponse.json({ tweets });
}
