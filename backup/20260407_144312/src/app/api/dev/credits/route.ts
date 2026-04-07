import { NextRequest, NextResponse } from "next/server";
import { getCreditBalance, giveCreditsPg, spendCreditsPg } from "@/lib/repository";

const DEV_PANEL = process.env.NEXT_PUBLIC_DEV_PANEL === "1";

export async function POST(req: NextRequest) {
  if (!DEV_PANEL) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let body: { userId?: unknown; balance?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Validate userId — same sanitization as getUserId()
  const rawId = typeof body.userId === "string" ? body.userId : "";
  const userId = rawId.match(/^[a-zA-Z0-9_-]{1,32}$/)?.[0];
  if (!userId) {
    return NextResponse.json({ error: "Invalid userId" }, { status: 400 });
  }

  // Validate target balance
  const target = Number(body.balance);
  if (!Number.isInteger(target) || target < 0 || target > 9999) {
    return NextResponse.json({ error: "Invalid balance" }, { status: 400 });
  }

  const current = (await getCreditBalance(userId)).balance;
  const delta = target - current;

  if (delta > 0) {
    await giveCreditsPg(userId, delta, "[dev] panel set");
  } else if (delta < 0) {
    await spendCreditsPg(userId, -delta, "[dev] panel set");
  }

  const updated = (await getCreditBalance(userId)).balance;
  console.log(`[dev] credits set user_id=${userId} ${current} → ${updated}`);

  return NextResponse.json({ ok: true, userId, balance: updated });
}
