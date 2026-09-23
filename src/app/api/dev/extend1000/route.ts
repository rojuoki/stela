/**
 * Dev-only endpoint: extend a user's unlock boundary by +1000 posts
 * without consuming credits.
 *
 * Guards:
 *   - Returns 404 unless NEXT_PUBLIC_DEV_PANEL === "1"
 *   - Never touches Stripe / credit hold / capture / spend
 *
 * Flow:
 *   grant_only  — DB already has ≥1000 cached posts beyond current boundary
 *                 → upsertUnlockBoundary immediately, no job created.
 *   excavate_more — blast-mode excavation job created (hold_id = null,
 *                   so capture/release is skipped in runJobAsync).
 *                   Client polls /api/jobs/:id as usual.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserId } from "@/lib/getUserId";
import { planAdditionalExcavation } from "@/lib/unlockPlanning";
import { upsertUnlockBoundary } from "@/lib/unlockWrite";
import {
  getAccountByUsernamePg,
  getUserBoundaryEndPg,
} from "@/lib/repository";
import { sanitizeDevUsername } from "@/lib/devOps";
import { createBulkExcavationJob } from "@/lib/jobs";

const DEV_PANEL = process.env.NEXT_PUBLIC_DEV_PANEL === "1";

export async function POST(req: NextRequest) {
  if (!DEV_PANEL) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const username = sanitizeDevUsername(body.username);
  if (!username) {
    return NextResponse.json({ error: "Invalid username" }, { status: 400 });
  }

  const account = await getAccountByUsernamePg(username);
  if (!account) {
    return NextResponse.json(
      { error: `Account @${username} not found. Unlock it first.` },
      { status: 404 },
    );
  }

  const userId = await getUserId(req);

  const currentBoundary = await getUserBoundaryEndPg(userId, account.account_id);
  const targetBoundary = currentBoundary + 1000;

  const plan = await planAdditionalExcavation(
    userId,
    account.account_id,
    targetBoundary,
  );

  console.log(`[dev-extend1000] @${username} plan:`, {
    executionMode: plan.executionMode,
    currentBoundary,
    targetBoundary,
    currentCachedCount: plan.currentCachedCount,
    missingCount: plan.missingCount,
  });

  // ── grant_only: DB cache is sufficient ────────────────────────────────────
  if (plan.executionMode === "grant_only") {
    await upsertUnlockBoundary(
      userId,
      account.account_id,
      plan.targetBoundary,
      "dev-extend1000-grant",
    );

    console.log(
      `[dev-extend1000] @${username} grant_only: ${currentBoundary} → ${plan.targetBoundary}`,
    );

    return NextResponse.json({
      success: true,
      executionMode: "grant_only",
      boundary: {
        previous: currentBoundary,
        new: plan.targetBoundary,
      },
      accountId: account.account_id,
    });
  }

  // ── excavate_more: blast-mode job ─────────────────────────────────────────
  if (plan.executionMode === "excavate_more") {
    const jobId = await createBulkExcavationJob(
      username,
      plan.targetBoundary,
      plan.missingCount,
      userId,
    );

    if (!jobId) {
      return NextResponse.json(
        { error: "Failed to create bulk excavation job" },
        { status: 500 },
      );
    }

    console.log(
      `[dev-extend1000] @${username} excavate_more: jobId=${jobId} targetBoundary=${plan.targetBoundary} missing=${plan.missingCount}`,
    );

    return NextResponse.json(
      {
        success: true,
        executionMode: "excavate_more",
        jobId,
        planning: {
          currentBoundary,
          targetBoundary: plan.targetBoundary,
          currentCachedCount: plan.currentCachedCount,
          missingCount: plan.missingCount,
        },
        accountId: account.account_id,
      },
      { status: 202 },
    );
  }

  return NextResponse.json(
    { error: "Invalid execution mode", executionMode: plan.executionMode },
    { status: 500 },
  );
}
