import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeIoPgPool, ioPgQuery } from "../src/lib/io/pg-db";
import { getIoCoveredPrefixPostsByRank } from "../src/lib/io/pg-cache";
import { requestIoPrefixUnlock } from "../src/lib/io/prefix-service";
import { finalizeIoPrefixExtension } from "../src/lib/io/prefix-settlement";

async function main(): Promise<void> {
  const suffix = randomUUID();
  const userId = `flow-user-${suffix}`;
  const accountId = `flow-account-${suffix}`;
  const username = `flow_${suffix.replaceAll("-", "").slice(0, 10)}`;
  const createdAt = "2020-01-01T00:00:00Z";
  try {
    await ioPgQuery(
      "INSERT INTO users (id, email, name, password_hash) VALUES ($1,$2,'Flow test','hash')",
      [userId, `${suffix}@example.invalid`],
    );
    await ioPgQuery(
      "INSERT INTO accounts (account_id, username, created_at) VALUES ($1,$2,$3)",
      [accountId, username, createdAt],
    );
    const baselineRunId = `flow-baseline-${suffix}`;
    await ioPgQuery(
      `INSERT INTO acquisition_runs (
         id, account_id, username, requested_by_user_id, provider, collection_mode,
         target_count, base_boundary, target_boundary, status, created_at, finished_at
       ) VALUES ($1,$2,$3,$4,'twitterapi_io','prefix_initial',1000,0,1000,'succeeded',NOW(),NOW())`,
      [baselineRunId, accountId, username, userId],
    );
    await ioPgQuery(
      `INSERT INTO posts (
         post_id, account_id, author_username, created_at, full_text, provider,
         source_run_id, coverage_state
       )
       SELECT $1 || '-' || value::text, $2, $3,
              $4::timestamptz + (value * INTERVAL '1 second'),
              'post ' || value::text, 'twitterapi_io', $5, 'covered'
       FROM generate_series(1, 1000) AS value`,
      [suffix, accountId, username, createdAt, baselineRunId],
    );
    await ioPgQuery(
      `INSERT INTO coverage_windows (
         run_id, account_id, provider, start_at, end_at, status, unique_count
       ) VALUES ($1,$2,'twitterapi_io',$3::timestamptz,$3::timestamptz + INTERVAL '1001 seconds','complete',1000)`,
      [baselineRunId, accountId, createdAt],
    );
    await ioPgQuery(
      `INSERT INTO user_unlocks (user_id, account_id, boundary_end, source_run_id)
       VALUES ($1,$2,1000,$3)`,
      [userId, accountId, baselineRunId],
    );

    const requested = await requestIoPrefixUnlock({ userId, username });
    assert.equal(requested.kind, "queued");
    if (requested.kind !== "queued") throw new Error("Expected queued prefix extension");
    assert.equal(requested.run.collection_mode, "prefix_extend");
    assert.equal(requested.run.base_boundary, 1000);
    assert.equal(requested.run.target_boundary, 2000);

    await ioPgQuery(
      `INSERT INTO posts (
         post_id, account_id, author_username, created_at, full_text, provider,
         source_run_id, coverage_state
       )
       SELECT $1 || '-' || value::text, $2, $3,
              $4::timestamptz + (value * INTERVAL '1 second'),
              'post ' || value::text, 'twitterapi_io', $5, 'covered'
       FROM generate_series(1001, 2000) AS value`,
      [suffix, accountId, username, createdAt, requested.run.id],
    );
    await ioPgQuery(
      `INSERT INTO coverage_windows (
         run_id, account_id, provider, start_at, end_at, status, unique_count
       ) VALUES (
         $1,$2,'twitterapi_io',$3::timestamptz + INTERVAL '1001 seconds',
         $3::timestamptz + INTERVAL '2001 seconds','complete',1000
       )`,
      [requested.run.id, accountId, createdAt],
    );
    await ioPgQuery(
      "UPDATE acquisition_runs SET status = 'succeeded', finished_at = NOW() WHERE id = $1",
      [requested.run.id],
    );
    const settlement = await finalizeIoPrefixExtension({
      runId: requested.run.id,
      userId,
      completionReason: "fixture_complete",
    });
    assert.equal(settlement.finalBoundary, 2000);
    assert.equal(settlement.grantedCount, 1000);

    const delta = await getIoCoveredPrefixPostsByRank(accountId, "twitterapi_io", {
      offset: requested.run.base_boundary ?? 0,
      limit: 1000,
    });
    assert.equal(delta?.posts.length, 1000);
    assert.equal(delta?.posts[0]?.rank, 1001);
    assert.equal(delta?.posts[999]?.rank, 2000);
    const full = await getIoCoveredPrefixPostsByRank(accountId, "twitterapi_io", { limit: 2000 });
    assert.equal(full?.posts.length, 2000);
    console.log("IO +1000 plan, settlement, delta, and full-prefix flow passed");
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
