import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { importAcquisitionResult } from "../src/lib/io/import-result";
import { getIoDatabase } from "../src/lib/io/db";

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "stela-provider-switch-"));
process.env.STELA_IO_DATABASE_PATH = path.join(temporaryDirectory, "stela.sqlite");

const twscrapePath = path.join(temporaryDirectory, "twscrape.json");
fs.writeFileSync(twscrapePath, JSON.stringify({
  schema_version: 1,
  provider: "twscrape",
  username: "jack",
  twscrape_version: "0.20.0",
  profile: {
    account_id: "12",
    username: "jack",
    display_name: "Jack",
    created_at: "2006-03-21T20:50:14Z",
  },
  config: { target_count: 1000 },
  result: { status: "SUCCESS", unique_post_count: 1 },
  metrics: { total_request_calls: 3, total_pages: 2, duplicate_sightings: 0 },
  windows: [{
    start: "2006-03-21T00:00:00Z",
    end: "2006-03-22T00:00:00Z",
    status: "COMPLETE",
    termination_reason: "cursor_exhausted",
    requests: 2,
    pages: 2,
    unique_post_count: 1,
  }],
  posts: [{
    id: "20",
    date: "2006-03-21T20:50:14Z",
    text: "just setting up my twttr",
    author_username: "jack",
    provider: "twscrape",
    seen_in_complete_result: true,
  }],
}), "utf8");

const twscrapeImport = importAcquisitionResult(twscrapePath, undefined, "twscrape");
assert.equal(twscrapeImport.accountId, "12");
assert.equal(twscrapeImport.postCount, 1);

const database = getIoDatabase();
const twscrapeRun = database.prepare(
  "SELECT provider, request_count FROM acquisition_runs WHERE id = ?",
).get(twscrapeImport.runId) as { provider: string; request_count: number };
assert.equal(twscrapeRun.provider, "twscrape");
assert.equal(twscrapeRun.request_count, 3);

const coverage = database.prepare(
  "SELECT status FROM coverage_windows WHERE run_id = ?",
).get(twscrapeImport.runId) as { status: string };
assert.equal(coverage.status, "complete");

const ioPath = path.join(temporaryDirectory, "twitterapi-io.json");
fs.writeFileSync(ioPath, JSON.stringify({
  schema_version: 1,
  username: "jack",
  profile: { account_id: "12", username: "jack", display_name: "Jack" },
  config: {
    target_count: 1000,
    collection_mode: "prefix_initial",
    collect_start: "2006-03-21T20:50:14Z",
  },
  result: { status: "EXPERIMENTAL_SUCCESS", unique_post_count: 2 },
  metrics: { total_requests: 4, total_pages: 3, duplicate_sightings: 1 },
  windows: [{
    start: "2006-03-21T20:50:14Z",
    end: "2006-03-23T00:00:00Z",
    status: "RESOLVED",
  }],
  candidate_posts: [
    {
      post_id: "20",
      created_at: "2006-03-21T20:50:14Z",
      text: "just setting up my twttr",
      author_username: "jack",
      provider: "twitterapi_io",
      seen_in_resolved_window: true,
    },
    {
      post_id: "29",
      created_at: "2006-03-22T07:00:00Z",
      text: "a second post",
      author_username: "jack",
      provider: "twitterapi_io",
      seen_in_resolved_window: true,
    },
  ],
}), "utf8");

const ioImport = importAcquisitionResult(ioPath, undefined, "twitterapi_io");
const ioRun = database.prepare(
  "SELECT collection_mode, requested_start_at FROM acquisition_runs WHERE id = ?",
).get(ioImport.runId) as { collection_mode: string; requested_start_at: string | null };
assert.equal(ioRun.collection_mode, "prefix_initial");
assert.equal(ioRun.requested_start_at, "2006-03-21T20:50:14Z");
const posts = database.prepare(
  "SELECT post_id, provider FROM posts ORDER BY created_at ASC, post_id ASC",
).all() as unknown as { post_id: string; provider: string }[];
assert.deepEqual(posts.map((post) => ({ ...post })), [
  { post_id: "20", provider: "twitterapi_io" },
  { post_id: "29", provider: "twitterapi_io" },
]);

console.log("provider switch import test passed");
