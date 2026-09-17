import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "stela-prefix-island-"));
process.env.STELA_IO_DATABASE_PATH = path.join(temporaryDirectory, "stela.sqlite");

async function main() {
const { importAcquisitionResult } = await import("../src/lib/io/import-result");
const { getIoDatabase } = await import("../src/lib/io/db");

const initialPath = path.join(temporaryDirectory, "initial.json");
fs.writeFileSync(initialPath, JSON.stringify({
  username: "sample", provider: "twitterapi_io",
  profile: { account_id: "sample-1", username: "sample", created_at: "2020-01-01T00:00:00Z" },
  config: { target_count: 1, collection_mode: "prefix_initial" },
  result: { status: "EXPERIMENTAL_SUCCESS", unique_post_count: 1 }, metrics: {},
  windows: [{ start: "2020-01-01T00:00:00Z", end: "2020-01-02T00:00:00Z", status: "RESOLVED" }],
  candidate_posts: [{ post_id: "one", created_at: "2020-01-01T12:00:00Z", text: "one", seen_in_resolved_window: true }],
}), "utf8");
importAcquisitionResult(initialPath, undefined, "twitterapi_io");

const islandPath = path.join(temporaryDirectory, "island.json");
fs.writeFileSync(islandPath, JSON.stringify({
  username: "sample", provider: "twitterapi_io",
  profile: { account_id: "sample-1", username: "sample", created_at: "2020-01-01T00:00:00Z" },
  config: {
    target_count: 1000, collection_mode: "prefix_extend",
    collect_start: "2020-01-03T00:00:00Z",
  },
  result: { status: "EXPERIMENTAL_SUCCESS", unique_post_count: 1 }, metrics: {},
  windows: [{ start: "2020-01-03T00:00:00Z", end: "2020-01-04T00:00:00Z", status: "RESOLVED" }],
  candidate_posts: [{ post_id: "island", created_at: "2020-01-03T12:00:00Z", text: "island", seen_in_resolved_window: true }],
}), "utf8");
const rejected = importAcquisitionResult(islandPath, undefined, "twitterapi_io");
assert.equal(rejected.postCount, 0);
assert.equal(rejected.candidateCount, 0);

const database = getIoDatabase();
assert.equal(database.prepare("SELECT COUNT(*) AS count FROM posts").get().count, 1);
assert.equal(database.prepare("SELECT COUNT(*) AS count FROM coverage_windows").get().count, 1);
assert.equal(
  database.prepare("SELECT COUNT(*) AS count FROM acquisition_runs WHERE id = ?")
    .get(rejected.runId).count,
  0,
);

console.log("disconnected prefix extension and its run are discarded");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
