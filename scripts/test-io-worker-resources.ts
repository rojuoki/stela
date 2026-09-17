import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { closeIoPgPool, ioPgQuery } from "../src/lib/io/pg-db";
import { createIoPgRun } from "../src/lib/io/pg-runs";

function processTreeRss(rootPid: number): number {
  const output = execFileSync("ps", ["-axo", "pid=,ppid=,rss="], { encoding: "utf8" });
  const rows = output.trim().split("\n").flatMap((line) => {
    const [pid, ppid, rss] = line.trim().split(/\s+/).map(Number);
    return Number.isFinite(pid) && Number.isFinite(ppid) && Number.isFinite(rss)
      ? [{ pid, ppid, rss }]
      : [];
  });
  const descendants = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (descendants.has(row.ppid) && !descendants.has(row.pid)) {
        descendants.add(row.pid);
        changed = true;
      }
    }
  }
  return rows.filter((row) => descendants.has(row.pid)).reduce((sum, row) => sum + row.rss, 0);
}

function peakOverlap(events: Array<{ started: number; finished: number }>): number {
  const points = events.flatMap((event) => [
    { at: event.started, delta: 1 },
    { at: event.finished, delta: -1 },
  ]).sort((left, right) => left.at - right.at || right.delta - left.delta);
  let active = 0;
  let peak = 0;
  for (const point of points) {
    active += point.delta;
    peak = Math.max(peak, active);
  }
  return peak;
}

async function main(): Promise<void> {
  const suffix = randomUUID();
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "stela-io-worker-state-"));
  const userIds = Array.from({ length: 8 }, (_, index) => `resource-user-${index}-${suffix}`);
  const usernames = Array.from({ length: 8 }, (_, index) => `res_${index}_${suffix.replaceAll("-", "").slice(0, 7)}`);
  const runIds: string[] = [];
  try {
    for (let index = 0; index < 8; index += 1) {
      await ioPgQuery(
        "INSERT INTO users (id, email, name, password_hash) VALUES ($1,$2,$3,'hash')",
        [userIds[index], `${index}-${suffix}@example.invalid`, `Resource ${index}`],
      );
      const run = await createIoPgRun({
        username: usernames[index],
        requestedByUserId: userIds[index],
        provider: "twitterapi_io",
        collectionMode: "prefix_initial",
        targetCount: 1000,
        baseBoundary: 0,
        targetBoundary: 1000,
      });
      runIds.push(run.id);
    }
    await closeIoPgPool();

    const child = spawn(process.execPath, ["--import", "tsx", "scripts/io-pg-worker.ts", "--once"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        STELA_IO_CONCURRENCY: "8",
        STELA_IO_PYTHON: "python3",
        STELA_IO_RUNNER_SCRIPT: path.join(process.cwd(), "scripts/fake-io-worker-runner.py"),
        STELA_IO_FAKE_STATE_DIR: stateDirectory,
        STELA_IO_WORK_DIRECTORY: path.join(stateDirectory, "work"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    let maximumConnections = 0;
    let maximumTreeRssKb = 0;
    const exit = new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    let exited = false;
    void exit.then(() => { exited = true; });
    while (!exited) {
      const connections = await ioPgQuery<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM pg_stat_activity WHERE datname = current_database()",
      );
      maximumConnections = Math.max(maximumConnections, Number(connections.rows[0]?.count ?? 0));
      if (child.pid) maximumTreeRssKb = Math.max(maximumTreeRssKb, processTreeRss(child.pid));
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const exitCode = await exit;
    assert.equal(exitCode, 0, stderr || stdout);

    const events = usernames.map((username) => JSON.parse(
      fs.readFileSync(path.join(stateDirectory, `${username}.json`), "utf8"),
    ) as { started: number; finished: number; rate_limit_file: string });
    assert.equal(peakOverlap(events), 8);
    assert.deepEqual([...new Set(events.map((event) => event.rate_limit_file))],
      [path.join(stateDirectory, "work", ".twitterapi-io-rate-limit")]);

    const completed = await ioPgQuery<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM acquisition_runs WHERE id = ANY($1::text[]) AND status = 'succeeded' AND request_count = 0 AND output_path IS NULL",
      [runIds],
    );
    assert.equal(Number(completed.rows[0]?.count), 8);
    for (const runId of runIds) {
      assert.equal(fs.existsSync(path.join(stateDirectory, "work", `${runId}-1`)), false);
    }
    assert.ok(maximumConnections <= 12, `unexpected Postgres connection peak: ${maximumConnections}`);
    console.log(JSON.stringify({
      peakRunnerConcurrency: peakOverlap(events),
      maximumPostgresConnections: maximumConnections,
      maximumWorkerTreeRssMb: Math.round(maximumTreeRssKb / 1024),
      completedRuns: 8,
      completedArtifactsRemaining: 0,
    }));
  } finally {
    await ioPgQuery("DELETE FROM user_unlocks WHERE user_id = ANY($1::text[])", [userIds]);
    await ioPgQuery("DELETE FROM coverage_windows WHERE run_id = ANY($1::text[])", [runIds]);
    await ioPgQuery("DELETE FROM posts WHERE source_run_id = ANY($1::text[])", [runIds]);
    await ioPgQuery("DELETE FROM acquisition_runs WHERE id = ANY($1::text[])", [runIds]);
    await ioPgQuery("DELETE FROM accounts WHERE username = ANY($1::text[])", [usernames]);
    await ioPgQuery("DELETE FROM users WHERE id = ANY($1::text[])", [userIds]);
    await closeIoPgPool();
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
