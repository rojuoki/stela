import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeIoPgPool, ioPgQuery } from "../src/lib/io/pg-db";
import { requestIoPrefixUnlock } from "../src/lib/io/prefix-service";
import { finalizeIoPrefixExtension } from "../src/lib/io/prefix-settlement";
import { getIoUnlockBoundary } from "../src/lib/io/pg-users";

async function main(): Promise<void> {
  const suffix = randomUUID();
  const users = [`concurrent-a-${suffix}`, `concurrent-b-${suffix}`];
  const accountId = `concurrent-account-${suffix}`;
  const username = `con_${suffix.replaceAll("-", "").slice(0, 10)}`;
  const sourceRunId = `concurrent-source-${suffix}`;
  const createdAt = "2022-01-01T00:00:00Z";
  try {
    for (let index = 0; index < users.length; index += 1) {
      await ioPgQuery(
        "INSERT INTO users (id, email, name, password_hash) VALUES ($1,$2,$3,'hash')",
        [users[index], `${index}-${suffix}@example.invalid`, `Concurrent ${index}`],
      );
    }
    await ioPgQuery(
      "INSERT INTO accounts (account_id, username, created_at) VALUES ($1,$2,$3)",
      [accountId, username, createdAt],
    );
    await ioPgQuery(
      `INSERT INTO acquisition_runs (
         id, account_id, username, requested_by_user_id, provider, collection_mode,
         target_count, base_boundary, target_boundary, status, created_at, finished_at
       ) VALUES ($1,$2,$3,$4,'twitterapi_io','prefix_initial',1000,0,1000,'succeeded',NOW(),NOW())`,
      [sourceRunId, accountId, username, users[0]],
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
      [suffix, accountId, username, createdAt, sourceRunId],
    );
    await ioPgQuery(
      `INSERT INTO coverage_windows (
         run_id, account_id, provider, start_at, end_at, status, unique_count
       ) VALUES ($1,$2,'twitterapi_io',$3::timestamptz,$3::timestamptz + INTERVAL '1001 seconds','complete',1000)`,
      [sourceRunId, accountId, createdAt],
    );
    for (const userId of users) {
      await ioPgQuery(
        `INSERT INTO user_unlocks (user_id, account_id, boundary_end, source_run_id)
         VALUES ($1,$2,1000,$3)`,
        [userId, accountId, sourceRunId],
      );
    }

    const requests = await Promise.all(users.map((userId) => requestIoPrefixUnlock({ userId, username })));
    assert.ok(requests.every((result) => result.kind === "queued"));
    assert.equal(new Set(requests.map((result) => result.run.id)).size, 1);
    assert.equal(requests.filter((result) => result.shared).length, 1);
    const acquisition = requests[0].run;
    assert.equal(acquisition.collection_mode, "prefix_extend");
    const ownerId = acquisition.requested_by_user_id!;
    const followerId = users.find((id) => id !== ownerId)!;

    await ioPgQuery(
      `INSERT INTO posts (
         post_id, account_id, author_username, created_at, full_text, provider,
         source_run_id, coverage_state
       )
       SELECT $1 || '-' || value::text, $2, $3,
              $4::timestamptz + (value * INTERVAL '1 second'),
              'post ' || value::text, 'twitterapi_io', $5, 'covered'
       FROM generate_series(1001, 2000) AS value`,
      [suffix, accountId, username, createdAt, acquisition.id],
    );
    await ioPgQuery(
      `INSERT INTO coverage_windows (
         run_id, account_id, provider, start_at, end_at, status, unique_count
       ) VALUES (
         $1,$2,'twitterapi_io',$3::timestamptz + INTERVAL '1001 seconds',
         $3::timestamptz + INTERVAL '2001 seconds','complete',1000
       )`,
      [acquisition.id, accountId, createdAt],
    );
    await ioPgQuery("UPDATE acquisition_runs SET status = 'succeeded', finished_at = NOW() WHERE id = $1", [acquisition.id]);
    await finalizeIoPrefixExtension({ runId: acquisition.id, userId: ownerId, completionReason: "fixture_complete" });

    const follower = await requestIoPrefixUnlock({ userId: followerId, username });
    assert.equal(follower.run.collection_mode, "prefix_grant");
    assert.equal(follower.shared, false);
    await closeIoPgPool();
    const worker = spawnSync(process.execPath, ["--import", "tsx", "scripts/io-pg-worker.ts", "--once"], {
      cwd: process.cwd(),
      env: { ...process.env, STELA_IO_CACHE_GRANT_DELAY_MS: "1" },
      encoding: "utf8",
    });
    assert.equal(worker.status, 0, worker.stderr || worker.stdout);

    assert.equal(await getIoUnlockBoundary(ownerId, accountId), 2000);
    assert.equal(await getIoUnlockBoundary(followerId, accountId), 2000);
    console.log("IO concurrent users shared one acquisition and settled independent boundaries");
  } finally {
    await ioPgQuery("DELETE FROM user_unlocks WHERE user_id = ANY($1::text[])", [users]);
    await ioPgQuery("DELETE FROM coverage_windows WHERE account_id = $1", [accountId]);
    await ioPgQuery("DELETE FROM posts WHERE account_id = $1", [accountId]);
    await ioPgQuery("DELETE FROM acquisition_runs WHERE username = $1", [username]);
    await ioPgQuery("DELETE FROM accounts WHERE account_id = $1", [accountId]);
    await ioPgQuery("DELETE FROM users WHERE id = ANY($1::text[])", [users]);
    await closeIoPgPool();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
