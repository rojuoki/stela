import type { PoolClient } from "pg";
import { computeIoCoverageFrontier, type IoCoverageInterval } from "./pg-cache";
import { ioPgQuery, withIoPgTransaction } from "./pg-db";

/** Recover a crash between result import and entitlement commit, before new work. */
export async function recoverIoPrefixSettlements(): Promise<void> {
  const pending = await ioPgQuery<{ id: string; requested_by_user_id: string }>(
    `SELECT id, requested_by_user_id FROM acquisition_runs
     WHERE status = 'succeeded' AND granted_boundary IS NULL
       AND collection_mode IN ('prefix_initial', 'prefix_extend', 'prefix_grant')
       AND account_id IS NOT NULL AND requested_by_user_id IS NOT NULL
       AND base_boundary IS NOT NULL AND target_boundary IS NOT NULL
     ORDER BY finished_at ASC`,
  );
  for (const run of pending.rows) {
    await finalizeIoPrefixExtension({
      runId: run.id, userId: run.requested_by_user_id, completionReason: "worker_restart",
    });
    await ioPgQuery(
      "UPDATE acquisition_runs SET checkpoint_json=NULL, output_path=NULL WHERE id=$1",
      [run.id],
    );
  }
}

export type IoPrefixSettlementKind = "full" | "partial" | "no-progress";

export interface IoPrefixSettlement {
  plannedBaseBoundary: number;
  previousBoundary: number;
  targetBoundary: number;
  availableBoundary: number;
  finalBoundary: number;
  grantedCount: number;
  kind: IoPrefixSettlementKind;
}

/**
 * Converts proven prefix availability into an entitlement result. The exact
 * available count is grantable even if it is below the requested +1000 target.
 */
export function settleIoPrefixExtension(input: {
  plannedBaseBoundary: number;
  previousBoundary: number;
  targetBoundary: number;
  availableBoundary: number;
}): IoPrefixSettlement {
  for (const [name, value] of Object.entries(input)) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`${name} must be a non-negative integer`);
    }
  }
  if (input.targetBoundary < input.plannedBaseBoundary) {
    throw new Error("Target boundary cannot precede its planned base");
  }

  // A concurrent request can only advance a user's boundary. Never regress it.
  const finalBoundary = Math.max(
    input.previousBoundary,
    Math.min(input.targetBoundary, input.availableBoundary),
  );
  const grantedCount = Math.max(0, finalBoundary - input.previousBoundary);
  return {
    ...input,
    finalBoundary,
    grantedCount,
    kind: finalBoundary >= input.targetBoundary
      ? "full"
      : grantedCount > 0
        ? "partial"
        : "no-progress",
  };
}

interface RunRow {
  id: string;
  account_id: string | null;
  requested_by_user_id: string | null;
  collection_mode: string;
  provider: string;
  status: string;
  base_boundary: number | null;
  target_boundary: number | null;
}

interface AccountRow {
  account_id: string;
  created_at: string | null;
}

async function coveredPrefixCountInTransaction(
  client: PoolClient,
  accountId: string,
  provider: string,
): Promise<number> {
  // Locking the account serializes settlement against another completion for
  // this account. Coverage is read only after this lock is obtained.
  const accountResult = await client.query<AccountRow>(
    `SELECT account_id, created_at::text AS created_at
     FROM accounts WHERE account_id = $1 FOR UPDATE`,
    [accountId],
  );
  const account = accountResult.rows[0];
  if (!account?.created_at) {
    throw new Error("Account creation time is unavailable");
  }
  const windows = await client.query<{ startAt: string; endAt: string }>(
    `SELECT start_at::text AS "startAt", end_at::text AS "endAt"
     FROM coverage_windows
     WHERE account_id = $1 AND provider = $2 AND status = 'complete'
     ORDER BY start_at ASC, end_at ASC`,
    [accountId, provider],
  );
  const frontier = computeIoCoverageFrontier(
    account.created_at,
    windows.rows as IoCoverageInterval[],
  );
  if (!frontier) throw new Error("Coverage frontier is invalid");

  const count = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM posts
     WHERE account_id = $1 AND provider = $2 AND coverage_state = 'covered'
       AND created_at >= $3::timestamptz AND created_at < $4::timestamptz`,
    [accountId, provider, frontier.startsAt, frontier.frontierAt],
  );
  return Number(count.rows[0]?.count ?? 0);
}

/**
 * Atomically recomputes the proven prefix after import and advances the user
 * boundary. A short timeline settles at its actual count rather than failing
 * the entire +1000 request.
 */
export async function finalizeIoPrefixExtension(input: {
  runId: string;
  userId: string;
  completionReason: string;
}): Promise<IoPrefixSettlement> {
  return withIoPgTransaction(async (client) => {
    const runResult = await client.query<RunRow>(
      `SELECT id, account_id, requested_by_user_id, collection_mode, provider, status,
              base_boundary, target_boundary
       FROM acquisition_runs WHERE id = $1 FOR UPDATE`,
      [input.runId],
    );
    const run = runResult.rows[0];
    if (!run?.account_id || !["prefix_initial", "prefix_extend", "prefix_grant"].includes(run.collection_mode)) {
      throw new Error("Run is not a prefix acquisition with an account");
    }
    if (run.status !== "succeeded") {
      throw new Error("Only a terminal resolved acquisition can advance an unlock");
    }
    if (run.requested_by_user_id && run.requested_by_user_id !== input.userId) {
      throw new Error("Run does not belong to this user");
    }
    if (!Number.isInteger(run.base_boundary) || !Number.isInteger(run.target_boundary)) {
      throw new Error("Run has no valid prefix boundaries");
    }

    const availableBoundary = await coveredPrefixCountInTransaction(
      client,
      run.account_id,
      run.provider,
    );
    const prior = await client.query<{ boundary_end: number }>(
      `SELECT boundary_end FROM user_unlocks
       WHERE user_id = $1 AND account_id = $2 FOR UPDATE`,
      [input.userId, run.account_id],
    );
    const previousBoundary = Number(prior.rows[0]?.boundary_end ?? 0);
    const settlement = settleIoPrefixExtension({
      plannedBaseBoundary: Number(run.base_boundary),
      previousBoundary,
      targetBoundary: Number(run.target_boundary),
      availableBoundary,
    });

    if (settlement.finalBoundary > previousBoundary) {
      await client.query(
        `INSERT INTO user_unlocks (user_id, account_id, boundary_end, source_run_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, account_id) DO UPDATE SET
           boundary_end = GREATEST(user_unlocks.boundary_end, EXCLUDED.boundary_end),
           source_run_id = EXCLUDED.source_run_id,
           unlocked_at = NOW()`,
        [input.userId, run.account_id, settlement.finalBoundary, run.id],
      );
    }

    await client.query(
      `UPDATE acquisition_runs
       SET status = 'succeeded', granted_boundary = $2,
           result_json = COALESCE(result_json, '{}'::jsonb) ||
             jsonb_build_object('prefix_settlement', $3::jsonb),
           finished_at = COALESCE(finished_at, NOW())
       WHERE id = $1`,
      [
        run.id,
        settlement.finalBoundary,
        JSON.stringify({ ...settlement, completionReason: input.completionReason }),
      ],
    );
    return settlement;
  });
}
