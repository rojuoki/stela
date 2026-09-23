import assert from "node:assert/strict";
import { getIoPgPool, closeIoPgPool } from "../src/lib/io/pg-db";
import { getOrFetchIoProfile, IoProfileError } from "../src/lib/io/profile";
process.env.STELA_IO_DATABASE_URL = "postgres://fixture:fixture@localhost:1/fixture";
process.env.TWITTERAPI_IO_API_KEY = "test-only";
const pool = getIoPgPool();
let cache = false;
let writes = 0;
let calls = 0;
let mode = "ok";
Object.defineProperty(pool, "query", { value: async (sql: string, values: unknown[]) => {
  if (sql.startsWith("SELECT")) return { rows: cache ? [{ username: "sample", display_name: "Cached" }] : [] };
  assert.ok(sql.startsWith("INSERT INTO accounts"));
  assert.equal(values[0], "123"); assert.equal(values[5], "2020-01-01T00:00:00.000Z"); assert.equal(values[7], 15);
  writes++; return { rows: [] };
} });
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  calls++;
  assert.match(String(input), /\/twitter\/user\/info\?userName=sample$/);
  assert.equal((init?.headers as Record<string, string>)["X-API-Key"], "test-only");
  if (mode === "limit") return new Response("{}", { status: 429 });
  return Response.json({ data: { id: "123", userName: mode === "mismatch" ? "other" : "sample", name: "Sample", createdAt: "Wed Jan 01 00:00:00 +0000 2020", followers: 15, following: 2, protected: true } });
};
async function main() {
  cache = true;
  assert.equal((await getOrFetchIoProfile("sample")).display_name, "Cached"); assert.equal(calls, 0);
  cache = false;
  const [a,b] = await Promise.all([getOrFetchIoProfile("sample"),getOrFetchIoProfile("sample")]);
  assert.equal(a.account_id, b.account_id); assert.equal(a.protected, true); assert.equal(calls, 1); assert.equal(writes, 1);
  mode = "limit";
  await assert.rejects(getOrFetchIoProfile("sample"), e => e instanceof IoProfileError && e.status === 429);
  mode = "mismatch";
  await assert.rejects(getOrFetchIoProfile("sample"), /一致しません/); assert.equal(writes, 1);
  console.log("Profile checks passed: cache reuse, concurrent lookup deduplication, normalized persistence, protected account, rate limit, identity mismatch.");
}
main().finally(async () => { globalThis.fetch=originalFetch; await closeIoPgPool(); }).catch(e => { console.error(e); process.exitCode=1; });
