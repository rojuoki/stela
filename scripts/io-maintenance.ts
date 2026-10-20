import fs from "node:fs";
import path from "node:path";
import { closeIoPgPool, ioPgQuery } from "../src/lib/io/pg-db";

const apply = process.argv.includes("--apply");
const workDirectory = path.resolve(process.env.STELA_IO_WORK_DIRECTORY || path.join(process.cwd(), "results", "io-pg-worker"));
const retentionDays = Math.max(1, Number.parseInt(process.env.STELA_IO_FAILED_ARTIFACT_RETENTION_DAYS || "7", 10) || 7);
const cutoff = Date.now() - retentionDays * 86400000;
const attemptDirectory = /^[0-9a-f-]{20,}-\d+$/i;

async function main() {
  const expiredLimits = await ioPgQuery<{ count: string }>(
    apply
      ? "WITH removed AS (DELETE FROM io_request_limits WHERE expires_at < NOW() RETURNING 1) SELECT COUNT(*)::TEXT AS count FROM removed"
      : "SELECT COUNT(*)::TEXT AS count FROM io_request_limits WHERE expires_at < NOW()",
  );
  const staleArtifacts: string[] = [];
  if (fs.existsSync(workDirectory)) {
    for (const name of fs.readdirSync(workDirectory)) {
      if (!attemptDirectory.test(name)) continue;
      const candidate = path.join(workDirectory, name);
      const stat = fs.lstatSync(candidate);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mtimeMs >= cutoff) continue;
      staleArtifacts.push(candidate);
      if (apply) fs.rmSync(candidate, { recursive: true, force: true });
    }
  }
  console.log(JSON.stringify({
    mode: apply ? "applied" : "dry-run",
    expiredRateLimitRows: Number(expiredLimits.rows[0]?.count || 0),
    staleArtifactDirectories: staleArtifacts.length,
    retentionDays,
    workDirectory,
  }));
}

main().finally(closeIoPgPool).catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
