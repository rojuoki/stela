import { closeIoPgPool, ioPgQuery } from "../src/lib/io/pg-db";

const REQUIRED_TABLES = [
  "accounts",
  "acquisition_runs",
  "posts",
  "coverage_windows",
  "io_schema_migrations",
  "users",
  "user_unlocks",
  "user_range_unlocks",
  "range_unlock_requests",
];

async function main() {
  try {
    await ioPgQuery("SELECT 1");
    const result = await ioPgQuery<{ name: string }>(
      `SELECT tablename AS name
       FROM pg_tables
       WHERE schemaname = 'public' AND tablename = ANY($1::text[])`,
      [REQUIRED_TABLES],
    );
    const found = new Set(result.rows.map((row) => row.name));
    const missing = REQUIRED_TABLES.filter((table) => !found.has(table));
    if (missing.length) throw new Error(`Missing IO tables: ${missing.join(", ")}`);
    console.log(`STELA IO Postgres verified: ${REQUIRED_TABLES.join(", ")}`);
  } finally {
    await closeIoPgPool();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
