import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { closeIoPgPool, ioPgQuery } from "../src/lib/io/pg-db";
import { createIoPgRun } from "../src/lib/io/pg-runs";
import { importIoPgAcquisitionResult } from "../src/lib/io/pg-import-result";

async function main() {
  const id = randomUUID();
  const username = `json_${id.slice(0, 8)}`;
  const accountId = `json-${id}`;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "io-json-test-"));
  const file = path.join(directory, "result.json");
  let runId: string | undefined;
  const media = [{ type: "photo", url: "https://example.invalid/image.jpg", caption: '日本語 "quote" \\ slash' }];
  const mentions = [{ username: "example", id: "123" }];
  try {
    const run = await createIoPgRun({ username, provider: "twitterapi_io", collectionMode: "prefix_initial", targetCount: 1000 });
    runId = run.id;
    fs.writeFileSync(file, JSON.stringify({
      username, profile: { account_id: accountId, username, created_at: "2020-01-01T00:00:00Z" },
      config: {}, result: { status: "EXPERIMENTAL_ACCOUNT_HAS_LESS_THAN_TARGET" }, metrics: {},
      windows: [{ start: "2020-01-01T00:00:00Z", end: "2020-01-02T00:00:00Z", status: "RESOLVED" }],
      candidate_posts: [
        { post_id: `${id}-1`, created_at: "2020-01-01T01:00:00Z", text: "with arrays", media, mentions },
        { post_id: `${id}-2`, created_at: "2020-01-01T02:00:00Z", text: "empty arrays", media: [], mentions: [] },
      ],
    }));
    await importIoPgAcquisitionResult(file, runId);
    const { rows } = await ioPgQuery("SELECT media_json, mentions_json FROM posts WHERE account_id = $1 ORDER BY created_at", [accountId]);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0].media_json, media);
    assert.deepEqual(rows[0].mentions_json, mentions);
    assert.equal(rows[1].media_json, null);
    assert.equal(rows[1].mentions_json, null);
    console.log("IO Postgres JSON array import passed");
  } finally {
    await ioPgQuery("DELETE FROM posts WHERE account_id = $1", [accountId]);
    if (runId) {
      await ioPgQuery("DELETE FROM coverage_windows WHERE run_id = $1", [runId]);
      await ioPgQuery("DELETE FROM acquisition_runs WHERE id = $1", [runId]);
    }
    await ioPgQuery("DELETE FROM accounts WHERE account_id = $1", [accountId]);
    fs.unlinkSync(file);
    fs.rmdirSync(directory);
    await closeIoPgPool();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
