import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeIoPgPool, ioPgQuery } from "../src/lib/io/pg-db";
import { claimNextIoPgRun, createIoPgRun } from "../src/lib/io/pg-runs";

async function main(): Promise<void> {
  const suffix = randomUUID();
  const userId = `queue-user-${suffix}`;
  const accountIds = Array.from({ length: 10 }, (_, index) => `queue-account-${index}-${suffix}`);
  const usernames = Array.from({ length: 10 }, (_, index) => `queue_${index}_${suffix.replaceAll("-", "")}`);
  try {
    await ioPgQuery(
      "INSERT INTO users (id, email, name, password_hash) VALUES ($1,$2,'Queue test','hash')",
      [userId, `${suffix}@example.invalid`],
    );
    for (let index = 0; index < accountIds.length; index += 1) {
      await ioPgQuery(
        "INSERT INTO accounts (account_id, username, created_at) VALUES ($1,$2,$3)",
        [accountIds[index], usernames[index], "2020-01-01T00:00:00Z"],
      );
    }
    const runs = [];
    for (let index = 0; index < accountIds.length; index += 1) {
      runs.push(await createIoPgRun({
        accountId: accountIds[index], username: usernames[index], requestedByUserId: userId,
        provider: "twitterapi_io", collectionMode: "prefix_initial", targetCount: 1000,
        baseBoundary: 0, targetBoundary: 1000,
      }));
    }
    assert.equal(runs.length, 10);
    await assert.rejects(
      createIoPgRun({
        accountId: accountIds[0], username: usernames[0], requestedByUserId: userId,
        provider: "twitterapi_io", collectionMode: "prefix_initial", targetCount: 1000,
        baseBoundary: 0, targetBoundary: 1000,
      }),
      /duplicate key|unique/i,
    );
    const claimed = await Promise.all(
      Array.from({ length: 8 }, (_, index) => claimNextIoPgRun(`queue-worker-${index}-${suffix}`)),
    );
    assert.equal(claimed.filter(Boolean).length, 8);
    assert.equal(new Set(claimed.map((run) => run?.id)).size, 8);

    const completed = claimed[0]!;
    await ioPgQuery(
      `UPDATE acquisition_runs
       SET status = 'succeeded', finished_at = NOW(), lease_expires_at = NULL
       WHERE id = $1`,
      [completed.id],
    );
    const replacement = await claimNextIoPgRun(`queue-worker-refill-${suffix}`);
    assert.ok(replacement);
    assert.ok(!claimed.some((run) => run?.id === replacement.id));

    const finalQueued = await claimNextIoPgRun(`queue-worker-final-${suffix}`);
    assert.ok(finalQueued);
    assert.equal(await claimNextIoPgRun(`queue-worker-empty-${suffix}`), null);

    const expired = claimed[1]!;
    await ioPgQuery(
      "UPDATE acquisition_runs SET lease_expires_at = NOW() - INTERVAL '1 second' WHERE id = $1",
      [expired.id],
    );
    const recovered = await claimNextIoPgRun(`queue-worker-recovery-${suffix}`);
    assert.equal(recovered?.id, expired.id);
    assert.equal(recovered?.attempt_count, 2);
    assert.equal(recovered?.worker_id, `queue-worker-recovery-${suffix}`);
    console.log("IO Postgres queue 8-claim, refill, duplicate, and lease recovery invariants passed");
  } finally {
    await ioPgQuery("DELETE FROM acquisition_runs WHERE requested_by_user_id = $1", [userId]);
    await ioPgQuery("DELETE FROM accounts WHERE account_id = ANY($1::text[])", [accountIds]);
    await ioPgQuery("DELETE FROM users WHERE id = $1", [userId]);
    await closeIoPgPool();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
