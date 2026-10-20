import assert from "node:assert/strict";
import { closeIoPgPool, getIoPgPool } from "../src/lib/io/pg-db";
import { consumeIoRateLimit } from "../src/lib/io/rate-limit";

process.env.STELA_IO_DATABASE_URL = "postgres://fixture:fixture@127.0.0.1:1/fixture";
process.env.STELA_IO_RATE_LIMIT_SALT = "isolated-rate-limit-test-secret";

const counts = new Map<string, number>();
const queries: { sql: string; values: unknown[] }[] = [];
const pool = getIoPgPool();
Object.defineProperty(pool, "query", { value: async (sql: string, values: unknown[] = []) => {
  queries.push({ sql, values });
  const key = `${values[0]}:${values[1]}:${String(values[2])}`;
  const limit = Number(values[4]);
  const previous = counts.get(key) || 0;
  if (previous >= limit) return { rows: [], rowCount: 0 };
  const requestCount = previous + 1;
  counts.set(key, requestCount);
  return { rows: [{ request_count: requestCount }], rowCount: 1 };
} });

async function main() {
  const now = Date.UTC(2026, 0, 1, 0, 0, 30);
  const first = await consumeIoRateLimit("preview", "203.0.113.1", 2, 60, now);
  const second = await consumeIoRateLimit("preview", "203.0.113.1", 2, 60, now + 1_000);
  const rejected = await consumeIoRateLimit("preview", "203.0.113.1", 2, 60, now + 2_000);
  const nextWindow = await consumeIoRateLimit("preview", "203.0.113.1", 2, 60, now + 31_000);

  assert.deepEqual([first.allowed, second.allowed, rejected.allowed, nextWindow.allowed], [true, true, false, true]);
  assert.equal(first.remaining, 1);
  assert.equal(second.remaining, 0);
  assert.equal(rejected.retryAfterSeconds, 28);
  assert.ok(!queries.some(query => query.values.includes("203.0.113.1")), "raw addresses must not reach PostgreSQL");
  assert.match(String(queries[0]?.values[1]), /^[a-f0-9]{64}$/);
  console.log("IO rate limits passed: fixed windows, rejection, reset, and hashed client subjects.");
}

main().finally(closeIoPgPool).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
