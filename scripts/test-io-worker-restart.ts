import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { closeIoPgPool, ioPgQuery } from "../src/lib/io/pg-db";
import { createIoPgRun, getIoPgRun } from "../src/lib/io/pg-runs";
import { importIoPgAcquisitionResult } from "../src/lib/io/pg-import-result";

async function until(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for worker state");
}

async function main(): Promise<void> {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "io-restart-"));
  const userId = randomUUID();
  const runs: string[] = [];
  const children: ChildProcess[] = [];
  const launch = (work: string, extra: Record<string, string> = {}, once = false) => {
    const child = spawn(process.execPath, ["--import", "tsx", "scripts/io-pg-worker.ts", ...(once ? ["--once"] : [])], {
      env: {
        ...process.env, STELA_IO_CONCURRENCY: "1", STELA_IO_WORK_DIRECTORY: work,
        STELA_IO_RUNNER_SCRIPT: path.resolve("scripts/fake-io-worker-runner.py"),
        STELA_IO_FAKE_STATE_DIR: path.join(temp, "state"), ...extra,
      }, stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    let output = "";
    child.stdout!.on("data", (chunk) => { output += chunk; });
    child.stderr!.on("data", (chunk) => { output += chunk; });
    const done = new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    return { child, done, output: () => output };
  };
  try {
    await ioPgQuery("INSERT INTO users (id,email,name,password_hash) VALUES ($1,$2,'Restart','hash')", [userId, `${userId}@example.invalid`]);
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      const username = `restart_${randomUUID().slice(0, 6)}`;
      const run = await createIoPgRun({ username, requestedByUserId: userId,
        provider: "twitterapi_io", collectionMode: "prefix_initial",
        targetCount: 1000, baseBoundary: 0, targetBoundary: 1000 });
      runs.push(run.id);
      const first = launch(path.join(temp, `first-${signal}`), { STELA_IO_FAKE_INTERRUPT: "1" });
      await until(async () => {
        const current = await getIoPgRun(run.id);
        return (current?.checkpoint_json as { resume?: { marker?: string } })?.resume?.marker === "saved-window";
      });
      const running = await getIoPgRun(run.id);
      assert.equal(running?.attempt_count, 1);
      // A second deployment must not claim while the first holds the session lock.
      const standby = launch(path.join(temp, `standby-${signal}`), {}, true);
      assert.equal(await standby.done, 0, standby.output());
      assert.equal((await getIoPgRun(run.id))?.attempt_count, 1);

      first.child.kill(signal);
      await first.done;
      // SIGKILL of a local parent leaves its child; simulate container teardown.
      const state = JSON.parse(fs.readFileSync(path.join(temp, "state", `${username}.json`), "utf8"));
      if (signal === "SIGKILL") {
        try { process.kill(state.pid, "SIGKILL"); } catch { /* already exited */ }
        await ioPgQuery("UPDATE acquisition_runs SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE id=$1", [run.id]);
      } else {
        assert.equal((await getIoPgRun(run.id))?.status, "queued", first.output());
        assert.throws(() => process.kill(state.pid, 0), "Python child must exit before job is requeued");
      }
      // Fresh directory represents Railway replacing the entire container filesystem.
      const resumed = launch(path.join(temp, `fresh-${signal}`), { STELA_IO_FAKE_REQUIRE_RESUME: "1" }, true);
      assert.equal(await resumed.done, 0, resumed.output());
      const complete = await getIoPgRun(run.id);
      assert.equal(complete?.status, "succeeded", resumed.output());
      assert.equal(complete?.attempt_count, 2);
      assert.equal(JSON.parse(fs.readFileSync(path.join(temp, "state", `${username}.json`), "utf8")).restored, true);
      const late = path.join(temp, "late.json");
      fs.writeFileSync(late, JSON.stringify({ username, profile: { account_id: `fake-${username}` } }));
      await assert.rejects(importIoPgAcquisitionResult(late, run.id, running!.worker_id!), /no longer owns/);
      // Simulate a crash after importing posts but before committing the user's grant.
      await ioPgQuery(
        `INSERT INTO posts (post_id,account_id,author_username,created_at,full_text,provider,source_run_id,coverage_state)
         VALUES ($1,$2,$3,'2020-01-01T01:00:00Z','restart fixture','twitterapi_io',$4,'covered')`,
        [run.id, `fake-${username}`, username, run.id],
      );
      await ioPgQuery("UPDATE acquisition_runs SET granted_boundary=NULL WHERE id=$1", [run.id]);
      const settlementWorker = launch(path.join(temp, `settlement-${signal}`), {}, true);
      assert.equal(await settlementWorker.done, 0, settlementWorker.output());
      assert.equal((await getIoPgRun(run.id))?.granted_boundary, 1);
      const unlock = await ioPgQuery<{ boundary_end: number }>(
        "SELECT boundary_end FROM user_unlocks WHERE user_id=$1 AND account_id=$2",
        [userId, `fake-${username}`],
      );
      assert.equal(unlock.rows[0]?.boundary_end, 1);
      console.log(`${signal}: fresh-container DB resume, singleton and stale-result rejection passed`);
    }
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await ioPgQuery("DELETE FROM user_unlocks WHERE user_id=$1", [userId]);
    await ioPgQuery("DELETE FROM coverage_windows WHERE run_id=ANY($1::text[])", [runs]);
    await ioPgQuery("DELETE FROM posts WHERE source_run_id=ANY($1::text[])", [runs]);
    await ioPgQuery("DELETE FROM acquisition_runs WHERE requested_by_user_id=$1", [userId]);
    await ioPgQuery("DELETE FROM users WHERE id=$1", [userId]);
    await closeIoPgPool();
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
