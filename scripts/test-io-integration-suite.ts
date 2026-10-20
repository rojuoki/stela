import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrateLocalIoPostgres, startLocalIoPostgres } from "./local-io-postgres.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "stela-io-integration-"));
const port = String(55500 + process.pid % 100);
process.env.STELA_IO_DATABASE_URL = `postgresql://postgres@127.0.0.1:${port}/postgres`;
process.env.STELA_IO_DEV_PG_ROOT = root;
process.env.STELA_IO_AUTH_SECRET = "isolated-integration-suite-secret-not-for-production";
process.env.STELA_IO_RATE_LIMIT_SALT = "isolated-integration-suite-rate-limit-salt";

const tests = [
  ["worker wake authentication", "scripts/test-io-worker-wake.ts"],
  ["Postgres queue", "scripts/test-io-pg-queue.ts"],
  ["prefix flow", "scripts/test-io-prefix-flow.ts"],
  ["cache-only grant", "scripts/test-io-cache-grant.ts"],
  ["prefix concurrency", "scripts/test-io-prefix-concurrency.ts"],
  ["failure settlement", "scripts/test-io-failure-settlement.ts"],
  ["worker restart", "scripts/test-io-worker-restart.ts"],
  ["worker resources", "scripts/test-io-worker-resources.ts"],
] as const;

async function main() {
  let database: Awaited<ReturnType<typeof startLocalIoPostgres>> | undefined;
  try {
    database = await startLocalIoPostgres();
    migrateLocalIoPostgres();
    for (const [label, file] of tests) {
      console.log(`\n[integration] ${label}`);
      const result = spawnSync(process.execPath, ["--import", "tsx", file], {
        cwd: process.cwd(),
        env: process.env,
        stdio: "inherit",
      });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`${label} failed with status ${result.status ?? "unknown"}`);
    }
    console.log("\n[integration] All isolated PostgreSQL and worker checks passed");
  } finally {
    await database?.stop().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
