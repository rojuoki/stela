import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { migrateLocalIoPostgres, startLocalIoPostgres } from "./local-io-postgres.mjs";

const root = `/private/tmp/stela-io-auth-flow-${process.pid}`;
process.env.STELA_IO_DATABASE_URL = "postgresql://postgres@127.0.0.1:55449/postgres";
process.env.STELA_IO_DEV_PG_ROOT = root;
process.env.STELA_IO_AUTH_SECRET = "isolated-auth-flow-test-secret-not-for-production";

function jsonRequest(path: string, body?: unknown, cookie?: string) {
  return new NextRequest(`http://localhost${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function authCookie(response: Response): string {
  const value = response.headers.get("set-cookie");
  assert.ok(value, "authentication response must set a cookie");
  return value.split(";", 1)[0];
}

async function main() {
  let database: Awaited<ReturnType<typeof startLocalIoPostgres>> | undefined;
  let closePool: (() => Promise<void>) | undefined;
  try {
  database = await startLocalIoPostgres();
  migrateLocalIoPostgres();
  const signup = (await import("../src/app/api/io/auth/signup/route")).POST;
  const login = (await import("../src/app/api/io/auth/login/route")).POST;
  const me = (await import("../src/app/api/io/auth/me/route")).GET;
  const logout = (await import("../src/app/api/io/auth/logout/route")).POST;
  const unlock = (await import("../src/app/api/io/unlocks/prefix/route")).POST;
  const myResults = (await import("../src/app/api/io/my-results/route")).GET;
  const accountPosts = (await import("../src/app/api/io/accounts/[username]/posts/route")).GET;
  const databaseModule = await import("../src/lib/io/pg-db");
  closePool = databaseModule.closeIoPgPool;

  const credentials = { name: "Local Tester", email: "local@example.invalid", password: "local-password" };
  const signupResponse = await signup(jsonRequest("/api/io/auth/signup", credentials));
  assert.equal(signupResponse.status, 200);
  const cookie = authCookie(signupResponse);
  assert.equal((await me(jsonRequest("/api/io/auth/me", undefined, cookie))).status, 200);
  assert.equal((await signup(jsonRequest("/api/io/auth/signup", credentials))).status, 409);
  assert.equal((await unlock(jsonRequest("/api/io/unlocks/prefix", { username: "authflowtest" }))).status, 401);

  const logoutResponse = await logout();
  assert.match(logoutResponse.headers.get("set-cookie") || "", /Max-Age=0/i);

  await closePool();
  await database.stop();
  database = await startLocalIoPostgres();
  migrateLocalIoPostgres();

  assert.equal((await login(jsonRequest("/api/io/auth/login", { email: credentials.email, password: "wrong-password" }))).status, 401);
  const loginResponse = await login(jsonRequest("/api/io/auth/login", credentials));
  assert.equal(loginResponse.status, 200, "user must survive the local database restart");
  const renewedCookie = authCookie(loginResponse);
  const unlockResponse = await unlock(jsonRequest("/api/io/unlocks/prefix", { username: "authflowtest" }, renewedCookie));
  assert.equal(unlockResponse.status, 202);
  const unlockBody = await unlockResponse.json();
  assert.equal(unlockBody.run.requested_by_user_id !== null, true);
  const runsModule = await import("../src/lib/io/pg-runs");
  const importModule = await import("../src/lib/io/pg-import-result");
  const claimed = await runsModule.claimNextIoPgRun("auth-flow-worker");
  assert.equal(claimed?.id, unlockBody.run.id);
  const progressFile = `${root}/progress.json`;
  const snapshot = (end: string, count: number) => ({
    username: "authflowtest",
    profile: { account_id: "auth-flow-account", username: "authflowtest", created_at: "2020-01-01T00:00:00Z" },
    config: { target_count: 1000, collection_mode: "prefix_initial", collect_start: "2020-01-01T00:00:00Z" },
    result: { status: "IN_PROGRESS", unique_post_count: count }, metrics: {},
    windows: [
      { start: "2020-01-01T00:00:00Z", end: "2020-01-02T00:00:00Z", status: "RESOLVED" },
      ...(count > 2 ? [{ start: "2020-01-02T00:00:00Z", end, status: "RESOLVED" }] : []),
    ],
    candidate_posts: Array.from({ length: count }, (_, index) => ({
      post_id: `auth-flow-${index + 1}`,
      created_at: `2020-01-${index < 2 ? "01" : "02"}T0${index + 1}:00:00Z`,
      text: `Post ${index + 1}`,
    })),
  });
  writeFileSync(progressFile, JSON.stringify(snapshot("2020-01-02T00:00:00Z", 2)));
  await importModule.importIoPgAcquisitionResult(progressFile, claimed!.id, "auth-flow-worker");
  let progressive = await databaseModule.ioPgQuery("SELECT boundary_end FROM user_unlocks WHERE user_id=$1", [unlockBody.run.requested_by_user_id]);
  assert.equal(Number(progressive.rows[0].boundary_end), 2);
  const deltaContext = { params: Promise.resolve({ username: "authflowtest" }) };
  const firstDeltaResponse = await accountPosts(jsonRequest(`/api/io/accounts/authflowtest/posts?view=delta&runId=${claimed!.id}`, undefined, renewedCookie), deltaContext);
  assert.equal(firstDeltaResponse.status, 200);
  const firstDelta = await firstDeltaResponse.json();
  assert.equal(firstDelta.posts.length, 2);
  assert.equal(firstDelta.boundary, 2);
  writeFileSync(progressFile, JSON.stringify(snapshot("2020-01-03T00:00:00Z", 4)));
  await importModule.importIoPgAcquisitionResult(progressFile, claimed!.id, "auth-flow-worker");
  progressive = await databaseModule.ioPgQuery("SELECT boundary_end FROM user_unlocks WHERE user_id=$1", [unlockBody.run.requested_by_user_id]);
  assert.equal(Number(progressive.rows[0].boundary_end), 4);
  const nextDeltaResponse = await accountPosts(jsonRequest(`/api/io/accounts/authflowtest/posts?view=delta&runId=${claimed!.id}&afterRank=2`, undefined, renewedCookie), deltaContext);
  assert.equal(nextDeltaResponse.status, 200);
  const nextDelta = await nextDeltaResponse.json();
  assert.equal(nextDelta.posts.length, 2);
  assert.equal(nextDelta.boundary, 4);
  const progressiveRun = await runsModule.getIoPgRun(claimed!.id);
  assert.equal(progressiveRun?.status, "running");
  assert.equal(progressiveRun?.granted_boundary, 4);
  const resultsResponse = await myResults(jsonRequest("/api/io/my-results", undefined, renewedCookie));
  assert.equal(resultsResponse.status, 200);
  assert.equal((await resultsResponse.json()).accounts[0].username, "authflowtest");

  const user = await databaseModule.ioPgQuery<{ id: string }>("SELECT id FROM users WHERE email=$1", [credentials.email]);
  await databaseModule.ioPgQuery("DELETE FROM users WHERE id=$1", [user.rows[0].id]);
  const staleResponse = await me(jsonRequest("/api/io/auth/me", undefined, renewedCookie));
  assert.equal(staleResponse.status, 401);
  assert.match(staleResponse.headers.get("set-cookie") || "", /Max-Age=0/i);
  console.log("IO auth, persistent local DB, progressive confirmed-window import, Unlock, and My Results flow passed");
  } finally {
    await closePool?.().catch(() => {});
    await database?.stop().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
