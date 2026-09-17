import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { closeIoPgPool, ioPgQuery } from "../src/lib/io/pg-db";
import { importIoPgAcquisitionResult } from "../src/lib/io/pg-import-result";
import {
  cancelIoPgRunForUser,
  claimNextIoPgRun,
  failIoPgRun,
} from "../src/lib/io/pg-runs";
import { requestIoPrefixUnlock } from "../src/lib/io/prefix-service";
import { finalizeIoPrefixExtension } from "../src/lib/io/prefix-settlement";
import { getIoUnlockBoundary } from "../src/lib/io/pg-users";

async function main(): Promise<void> {
  const suffix = randomUUID();
  const userId = `failure-user-${suffix}`;
  const accountId = `failure-account-${suffix}`;
  const username = `fail_${suffix.replaceAll("-", "").slice(0, 10)}`;
  const sourceRunId = `failure-source-${suffix}`;
  const createdAt = "2023-01-01T00:00:00Z";
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "stela-io-failure-"));
  try {
    await ioPgQuery(
      "INSERT INTO users (id, email, name, password_hash) VALUES ($1,$2,'Failure test','hash')",
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
    await ioPgQuery(
      `INSERT INTO user_unlocks (user_id, account_id, boundary_end, source_run_id)
       VALUES ($1,$2,1000,$3)`,
      [userId, accountId, sourceRunId],
    );

    const failedRequest = await requestIoPrefixUnlock({ userId, username });
    const workerId = `failure-worker-${suffix}`;
    const claimed = await claimNextIoPgRun(workerId);
    assert.equal(claimed?.id, failedRequest.run.id);
    await failIoPgRun({
      id: failedRequest.run.id,
      workerId,
      message: "simulated timeout",
      errorCode: "worker_failed",
    });
    await assert.rejects(
      finalizeIoPrefixExtension({ runId: failedRequest.run.id, userId, completionReason: "should_not_settle" }),
      /terminal resolved acquisition/,
    );
    assert.equal(await getIoUnlockBoundary(userId, accountId), 1000);

    const canceledRequest = await requestIoPrefixUnlock({ userId, username });
    const canceled = await cancelIoPgRunForUser(canceledRequest.run.id, userId);
    assert.equal(canceled?.status, "canceled");
    const lateResultPath = path.join(temporaryDirectory, "late-result.json");
    fs.writeFileSync(lateResultPath, JSON.stringify({
      username,
      profile: { account_id: accountId, username, created_at: createdAt },
      config: { collection_mode: "prefix_extend", collect_start: canceledRequest.run.requested_start_at },
      result: { status: "EXPERIMENTAL_SUCCESS", unique_post_count: 1 },
      metrics: {},
      windows: [],
      candidate_posts: [],
    }));
    const lateImport = await importIoPgAcquisitionResult(lateResultPath, canceledRequest.run.id);
    assert.equal(lateImport.discarded, true);
    await assert.rejects(
      finalizeIoPrefixExtension({ runId: canceledRequest.run.id, userId, completionReason: "late_result" }),
      /terminal resolved acquisition/,
    );
    assert.equal(await getIoUnlockBoundary(userId, accountId), 1000);
    console.log("IO failure, timeout, cancellation, and late-result settlement guards passed");
  } finally {
    await ioPgQuery("DELETE FROM user_unlocks WHERE user_id = $1", [userId]);
    await ioPgQuery("DELETE FROM coverage_windows WHERE account_id = $1", [accountId]);
    await ioPgQuery("DELETE FROM posts WHERE account_id = $1", [accountId]);
    await ioPgQuery("DELETE FROM acquisition_runs WHERE username = $1", [username]);
    await ioPgQuery("DELETE FROM accounts WHERE account_id = $1", [accountId]);
    await ioPgQuery("DELETE FROM users WHERE id = $1", [userId]);
    await closeIoPgPool();
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
