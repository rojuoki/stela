import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeIoPgPool, ioPgQuery } from "../src/lib/io/pg-db";
import { getIoPgRun } from "../src/lib/io/pg-runs";
import { requestIoPrefixUnlock } from "../src/lib/io/prefix-service";
import { getIoUnlockBoundary } from "../src/lib/io/pg-users";

async function main(): Promise<void> {
  const suffix = randomUUID();
  const userId = `cache-user-${suffix}`;
  const accountId = `cache-account-${suffix}`;
  const username = `cache_${suffix.replaceAll("-", "").slice(0, 9)}`;
  const sourceRunId = `cache-source-${suffix}`;
  const createdAt = "2021-01-01T00:00:00Z";
  let queuedRunId: string | null = null;
  try {
    await ioPgQuery(
      "INSERT INTO users (id, email, name, password_hash) VALUES ($1,$2,'Cache test','hash')",
      [userId, `${suffix}@example.invalid`],
    );
    await ioPgQuery(
      "INSERT INTO accounts (account_id, username, created_at) VALUES ($1,$2,$3)",
      [accountId, username, createdAt],
    );
    await ioPgQuery(
      `INSERT INTO acquisition_runs (
         id, account_id, username, requested_by_user_id, provider, collection_mode,
         target_count, base_boundary, target_boundary, status, created_at, finished_at
       ) VALUES ($1,$2,$3,$4,'twitterapi_io','prefix_initial',1000,0,1000,'succeeded',NOW(),NOW())`,
      [sourceRunId, accountId, username, userId],
    );
    await ioPgQuery(
      `INSERT INTO posts (
         post_id, account_id, author_username, created_at, full_text, provider,
         source_run_id, coverage_state
       )
       SELECT $1 || '-' || value::text, $2, $3,
              $4::timestamptz + (value * INTERVAL '1 second'),
              'cached post ' || value::text, 'twitterapi_io', $5, 'covered'
       FROM generate_series(1, 1000) AS value`,
      [suffix, accountId, username, createdAt, sourceRunId],
    );
    await ioPgQuery(
      `INSERT INTO coverage_windows (
         run_id, account_id, provider, start_at, end_at, status, unique_count
       ) VALUES ($1,$2,'twitterapi_io',$3::timestamptz,$3::timestamptz + INTERVAL '1001 seconds','complete',1000)`,
      [sourceRunId, accountId, createdAt],
    );

    const request = await requestIoPrefixUnlock({ userId, username });
    assert.equal(request.kind, "queued");
    assert.equal(request.reused, true);
    assert.equal(request.run.collection_mode, "prefix_grant");
    queuedRunId = request.run.id;
    assert.equal(await getIoUnlockBoundary(userId, accountId), 0);

    await closeIoPgPool();
    const worker = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/io-pg-worker.ts", "--once"],
      {
        cwd: process.cwd(),
        env: { ...process.env, STELA_IO_CACHE_GRANT_DELAY_MS: "1" },
        encoding: "utf8",
      },
    );
    assert.equal(worker.status, 0, worker.stderr || worker.stdout);

    const completed = await getIoPgRun(queuedRunId);
    assert.equal(completed?.status, "succeeded");
    assert.equal(completed?.request_count, 0);
    assert.equal(Number(completed?.estimated_cost_usd), 0);
    assert.equal(completed?.granted_boundary, 1000);
    assert.equal(await getIoUnlockBoundary(userId, accountId), 1000);
    console.log("IO cache-only grant used worker settlement with zero provider requests");
  } finally {
    await ioPgQuery("DELETE FROM user_unlocks WHERE user_id = $1", [userId]);
    await ioPgQuery("DELETE FROM coverage_windows WHERE account_id = $1", [accountId]);
    await ioPgQuery("DELETE FROM posts WHERE account_id = $1", [accountId]);
    await ioPgQuery("DELETE FROM acquisition_runs WHERE requested_by_user_id = $1", [userId]);
    await ioPgQuery("DELETE FROM accounts WHERE account_id = $1", [accountId]);
    await ioPgQuery("DELETE FROM users WHERE id = $1", [userId]);
    await closeIoPgPool();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
