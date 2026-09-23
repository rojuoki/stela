import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { getIoPgPool, closeIoPgPool } from "../src/lib/io/pg-db";
import { createIoToken } from "../src/lib/io/auth";
import { GET as account } from "../src/app/api/io/accounts/[username]/route";
import { GET as posts } from "../src/app/api/io/accounts/[username]/posts/route";
import { GET as results } from "../src/app/api/io/my-results/route";
import { GET as run } from "../src/app/api/io/runs/[id]/route";
import { POST as prefix } from "../src/app/api/io/unlocks/prefix/route";
import { POST as range } from "../src/app/api/io/unlocks/range/route";
import { POST as retiredRun } from "../src/app/api/io/runs/route";

// All DB queries are intercepted. No real database or provider is contacted.
process.env.STELA_IO_DATABASE_URL = "postgres://fixture:fixture@127.0.0.1:1/fixture";
process.env.STELA_IO_AUTH_SECRET = "isolated-ui-route-test-secret-not-for-production";
process.env.STELA_IO_USE_POSTGRES = "0"; // No accidental SQLite fallback, even with an old flag.
const queries: { sql: string; values: unknown[] }[] = [];
const fixtureAccount = { account_id: "account", username: "sample", created_at: "2020-01-01T00:00:00Z", display_name: "Sample" };
const pool = getIoPgPool();
Object.defineProperty(pool, "query", { value: async (sql: string, values: unknown[] = []) => {
  queries.push({ sql, values });
  assert.match(sql.trim(), /^(SELECT|WITH)\b/);
  let rows: unknown[];
  if (sql.includes("WITH activity")) { assert.deepEqual(values, ["viewer"]); rows = [{ username: "sample", updated_at: "2020-01-01" }]; }
  else if (sql.includes("FROM accounts")) rows = [fixtureAccount];
  else if (sql.includes("FROM user_unlocks")) rows = values[0] === "viewer" ? [{ boundary_end: 2 }] : [];
  else if (sql.includes("FROM user_range_unlocks")) rows = [];
  else if (sql.includes("FROM acquisition_runs") || sql.includes("FROM range_unlock_requests")) rows = [];
  else if (sql.includes("FROM coverage_windows")) rows = [{ startAt: "2020-01-01T00:00:00Z", endAt: "2020-02-01T00:00:00Z" }];
  else if (sql.includes("COUNT(*)")) rows = [{ count: "1000" }];
  else if (sql.includes("WITH ranked_posts")) {
    assert.equal(values[4], 2, "limit must be capped by the caller's unlock boundary");
    rows = [1, 2].map(n => ({ post_id: `${n}`, account_id: "account", author_username: "sample", created_at: `2020-01-0${n}T00:00:00Z`, full_text: `Post ${n}`, rank: n, provider: "twitterapi_io", coverage_state: "covered" }));
  } else throw new Error(`Unmocked query: ${sql}`);
  return { rows, rowCount: rows.length };
} });
async function main() {
  const token = await createIoToken({ id: "viewer", name: "Viewer", email: "viewer@example.invalid" });
  const otherToken = await createIoToken({ id: "other", name: "Other", email: "other@example.invalid" });
  const request = (path: string, auth?: string) => new NextRequest(`http://localhost${path}`, { headers: auth ? { cookie: `stela-io-auth-token=${auth}` } : {} });
  const ctx = { params: Promise.resolve({ username: "sample" }) };
  const publicProfile = await (await account(request("/api/io/accounts/sample"), ctx)).json();
  assert.equal(publicProfile.account.username, "sample"); assert.equal(publicProfile.boundary, 0); assert.equal(publicProfile.latestRun, null); assert.deepEqual(publicProfile.ranges, []);
  assert.equal((await posts(request("/api/io/accounts/sample/posts"), ctx)).status, 401);
  assert.equal((await results(request("/api/io/my-results"))).status, 401);
  assert.equal((await prefix(request("/api/io/unlocks/prefix"))).status, 401);
  assert.equal((await range(request("/api/io/unlocks/range"))).status, 401);
  assert.equal((await run(request("/api/io/runs/unknown"), { params: Promise.resolve({ id: "unknown" }) })).status, 401);
  const own = await (await account(request("/api/io/accounts/sample", token), ctx)).json();
  assert.equal(own.boundary, 2);
  const readable = await (await posts(request("/api/io/accounts/sample/posts?limit=50000", token), ctx)).json();
  assert.equal(readable.posts.length, 2); assert.equal(readable.boundary, 2);
  const other = await (await posts(request("/api/io/accounts/sample/posts", otherToken), ctx)).json();
  assert.equal(other.posts.length, 0);
  const forbiddenRange = await posts(request("/api/io/accounts/sample/posts?view=range&startAt=2020-01-01&endAt=2020-01-02", token), ctx);
  assert.equal(forbiddenRange.status, 403);
  const list = await (await results(request("/api/io/my-results", token))).json(); assert.equal(list.accounts[0].username, "sample");
  assert.equal((await retiredRun()).status, 410);
  assert.ok(queries.length > 0);
  console.log("IO product routes passed: public profile, login requirement, per-user boundaries, range ownership, My Results, retired SQLite entry point.");
}
main().finally(closeIoPgPool).catch(e => { console.error(e); process.exitCode = 1; });
