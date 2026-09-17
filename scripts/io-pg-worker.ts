import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { closeIoPgPool, getIoPgPool } from "../src/lib/io/pg-db";
import { importIoPgAcquisitionResult } from "../src/lib/io/pg-import-result";
import { claimNextIoPgRun, clearIoPgRunOutputPath, completeIoPgCacheGrant, failIoPgRun, requeueIoPgRun, updateIoPgRunProgress, type IoPgRun } from "../src/lib/io/pg-runs";
import { finalizeIoPrefixExtension, recoverIoPrefixSettlements } from "../src/lib/io/prefix-settlement";
import { advanceIoRangeRequest } from "../src/lib/io/range-service";
import { runWorkerCoordinator } from "../src/lib/io/worker-coordinator";

const workerId = `${process.env.STELA_IO_WORKER_ID || "io-worker"}-${randomUUID()}`;
const once = process.argv.includes("--once");
const workDirectory = process.env.STELA_IO_WORK_DIRECTORY
  || path.join(process.cwd(), "results", "io-pg-worker");
const shutdown = new AbortController();
const children = new Set<ChildProcess>();
class Interrupted extends Error {}

function stopWorker(): void {
  if (shutdown.signal.aborted) return;
  console.log("[worker] stopping; saving progress before returning unfinished jobs");
  shutdown.abort();
  for (const child of children) child.kill("SIGTERM");
  const forceStop = setTimeout(() => {
    for (const child of children) child.kill("SIGKILL");
  }, 5_000);
  forceStop.unref();
}
process.on("SIGTERM", stopWorker);
process.on("SIGINT", stopWorker);
const maxConcurrency = Math.max(
  1,
  Number.parseInt(process.env.STELA_IO_CONCURRENCY || "8", 10) || 8,
);

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function progressFrom(file: string): {
  message?: string; requestCount?: number; pageCount?: number; uniqueCount?: number;
  candidateCount?: number; duplicateCount?: number; checkpoint?: unknown;
} {
  const payload = readJson(file);
  if (!payload) return {};
  const result = payload.result && typeof payload.result === "object" ? payload.result as Record<string, unknown> : {};
  const metrics = payload.metrics && typeof payload.metrics === "object" ? payload.metrics as Record<string, unknown> : {};
  const number = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : undefined;
  return {
    message: typeof result.progress_message === "string" ? result.progress_message : undefined,
    requestCount: number(metrics.total_requests ?? metrics.total_request_calls),
    pageCount: number(metrics.total_pages), uniqueCount: number(result.unique_post_count),
    candidateCount: number(metrics.candidate_unique_count), duplicateCount: number(metrics.duplicate_sightings),
  };
}

async function runPython(run: IoPgRun, outputPath: string, progressPath: string): Promise<number | null> {
  if (shutdown.signal.aborted) throw new Interrupted();
  if (run.provider !== "twitterapi_io") {
    throw new Error(`Unsupported worker provider: ${run.provider}`);
  }
  const python = process.env.STELA_IO_PYTHON || "python3";
  const sharedRequestsPerSecond = Math.max(
    0.1,
    Number(process.env.STELA_IO_PROVIDER_REQUESTS_PER_SECOND || "6") || 6,
  );
  const sharedRateLimitPath = path.join(workDirectory, ".twitterapi-io-rate-limit");
  const args = [
    process.env.STELA_IO_RUNNER_SCRIPT || path.join(process.cwd(), "scripts/measure_twitterapi_io_1000.py"), run.username,
    "--collection-mode", run.collection_mode,
    "--target-count", String(run.target_count || 1000),
    "--output", outputPath,
    "--checkpoint", `${outputPath}.checkpoint.json`,
    "--progress-output", progressPath,
    "--request-interval", process.env.STELA_IO_REQUEST_INTERVAL || "0.7",
    "--shared-rate-limit-file", sharedRateLimitPath,
    "--shared-request-interval", String(1 / sharedRequestsPerSecond),
  ];
  if (process.env.STELA_IO_MAX_REQUESTS) {
    args.push("--max-requests", process.env.STELA_IO_MAX_REQUESTS);
  }
  if (process.env.STELA_IO_MAX_ESTIMATED_COST_USD) {
    args.push("--max-estimated-cost-usd", process.env.STELA_IO_MAX_ESTIMATED_COST_USD);
  }
  if (run.collection_mode === "prefix_extend") {
    if (!run.requested_start_at) throw new Error("prefix_extend run has no requested_start_at");
    args.push("--collect-start", run.requested_start_at);
  }
  if (run.collection_mode === "date_range") {
    if (!run.requested_start_at || !run.requested_end_at) {
      throw new Error("date_range run is missing requested bounds");
    }
    args.push("--collect-start", run.requested_start_at, "--collect-end", run.requested_end_at);
  }
  return new Promise((resolve, reject) => {
    const child = spawn(python, args, { cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    children.add(child);
    let interrupted = false;
    // Serialize writes: an older progress snapshot must never overwrite a newer one.
    let pending = Promise.resolve();
    const saveProgress = () => {
      pending = pending.then(async () => {
        const checkpoint = readJson(`${outputPath}.checkpoint.json`);
        const renewed = await updateIoPgRunProgress({
          id: run.id, workerId, ...progressFrom(progressPath),
          checkpoint: checkpoint?.experiment === "twitterapi_io_oldest_block_checkpoint"
            ? checkpoint : undefined,
        });
        if (!renewed) throw new Interrupted("Worker lease lost or run canceled");
      }).catch((error) => {
        interrupted = true;
        child.kill("SIGTERM");
        console.error("[worker] Progress persistence failed; stopping acquisition", error);
      });
      return pending;
    };
    const leaseHeartbeat = setInterval(() => { void saveProgress(); }, 30_000);
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk}`.slice(-4_000); });
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      if (line.startsWith("PROGRESS ")) void saveProgress();
    });
    child.on("error", (error) => {
      clearInterval(leaseHeartbeat);
      children.delete(child);
      reject(error);
    });
    child.on("close", async (code) => {
      clearInterval(leaseHeartbeat);
      children.delete(child);
      await saveProgress();
      if (shutdown.signal.aborted || interrupted) {
        reject(new Interrupted("Acquisition interrupted; resume from saved checkpoint"));
        return;
      }
      if (code === 0 || fs.existsSync(outputPath)) resolve(code);
      else reject(new Error(stderr || `Runner exited with code ${code ?? "unknown"}`));
    });
  });
}

function removeCompletedArtifacts(outputPath: string, progressPath: string): void {
  for (const file of [outputPath, progressPath, `${outputPath}.checkpoint.json`]) {
    try {
      fs.rmSync(file, { force: true });
    } catch (error) {
      console.error(`[worker] Could not remove completed artifact ${file}`, error);
    }
  }
}

async function processRun(run: IoPgRun): Promise<void> {
  // Each attempt has private files: an expired worker cannot overwrite its successor.
  const directory = path.join(
    workDirectory,
    `${run.id}-${run.attempt_count}`,
  );
  fs.mkdirSync(directory, { recursive: true });
  const outputPath = path.join(directory, `${run.id}.json`);
  const progressPath = `${outputPath}.progress.json`;
  try {
    if (shutdown.signal.aborted) throw new Interrupted();
    const saved = run.checkpoint_json as Record<string, unknown> | null;
    if (saved?.experiment === "twitterapi_io_oldest_block_checkpoint") {
      fs.writeFileSync(`${outputPath}.checkpoint.json`, JSON.stringify(saved));
    } else if (saved) {
      throw new Error("Legacy progress snapshot cannot restore a runner checkpoint");
    }
    if (run.collection_mode === "prefix_grant") {
      const configuredDelay = Number.parseInt(process.env.STELA_IO_CACHE_GRANT_DELAY_MS || "750", 10);
      await wait(Math.max(0, Math.min(5_000, configuredDelay || 750)));
      if (shutdown.signal.aborted) throw new Interrupted();
      await completeIoPgCacheGrant({ id: run.id, workerId });
      await finalizeIoPrefixExtension({
        runId: run.id,
        userId: run.requested_by_user_id!,
        completionReason: "shared_cache",
      });
      return;
    }
    await runPython(run, outputPath, progressPath);
    const imported = await importIoPgAcquisitionResult(outputPath, run.id, workerId);
    if (imported.discarded) {
      if (run.collection_mode === "date_range" && run.range_request_id) {
        await advanceIoRangeRequest(run.range_request_id, run.id, false);
      }
      removeCompletedArtifacts(outputPath, progressPath);
      await clearIoPgRunOutputPath(run.id, workerId);
      return;
    }
    if (run.collection_mode === "date_range") {
      if (run.range_request_id) {
        await advanceIoRangeRequest(run.range_request_id, run.id, imported.terminalSuccess);
      }
      removeCompletedArtifacts(outputPath, progressPath);
      await clearIoPgRunOutputPath(run.id, workerId);
      return;
    }
    if (!imported.terminalSuccess) return;
    const payload = readJson(outputPath);
    const result = payload?.result && typeof payload.result === "object" ? payload.result as Record<string, unknown> : {};
    await finalizeIoPrefixExtension({
      runId: run.id,
      userId: run.requested_by_user_id!,
      completionReason: typeof result.status === "string" ? result.status : "terminal_success",
    });
    removeCompletedArtifacts(outputPath, progressPath);
    await clearIoPgRunOutputPath(run.id, workerId);
  } catch (error) {
    if (error instanceof Interrupted) {
      await requeueIoPgRun(run.id, workerId);
      return;
    }
    await failIoPgRun({
      id: run.id, workerId,
      message: error instanceof Error ? error.message : String(error),
      errorCode: "worker_failed", outputPath,
    });
    if (run.collection_mode === "date_range" && run.range_request_id) {
      await advanceIoRangeRequest(run.range_request_id, run.id, false);
    }
  } finally {
    try { fs.rmdirSync(directory); } catch { /* Nonempty interrupted attempts remain disposable. */ }
  }
}

async function main(): Promise<void> {
  if (process.env.STELA_IO_WORKER_DATABASE_URL) {
    process.env.STELA_IO_DATABASE_URL = process.env.STELA_IO_WORKER_DATABASE_URL;
  }
  const databaseUrl = process.env.STELA_IO_DATABASE_URL;
  if (!databaseUrl) throw new Error("STELA_IO_DATABASE_URL is required");
  if (new URL(databaseUrl).hostname.includes("-pooler.")) {
    throw new Error("Worker requires Neon's direct connection URL for its session lock");
  }
  // Session lock also covers Railway's brief old/new deployment overlap.
  // Connect directly to Postgres, not through a transaction-mode pooler.
  const lock = await getIoPgPool(true).connect();
  lock.on("error", (error) => {
    console.error("[worker] Coordinator connection lost", error);
    process.exitCode = 1;
    stopWorker();
  });
  let lockHeartbeat: ReturnType<typeof setInterval> | undefined;
  try {
    while (!shutdown.signal.aborted) {
      const acquired = await lock.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock(1937007980, 8) AS acquired",
      );
      if (acquired.rows[0].acquired) break;
      if (once) return;
      await wait(1_000);
    }
    if (shutdown.signal.aborted) return;
    lockHeartbeat = setInterval(() => {
      void lock.query("SELECT 1").catch(() => { process.exitCode = 1; stopWorker(); });
    }, 10_000);
    await recoverIoPrefixSettlements();
    console.log(`[worker] ready slots=${maxConcurrency}; interrupted jobs resume from Postgres`);
    await runWorkerCoordinator({
      concurrency: maxConcurrency,
      claim: async () => {
        try { return await claimNextIoPgRun(workerId); }
        catch (error) { stopWorker(); throw error; }
      },
      process: async (run) => {
        try {
          await processRun(run);
        } catch (error) {
          console.error(`[worker] Unhandled run error for ${run.id}:`, error);
        }
      },
      idleWait: () => wait(1_000),
      once,
      signal: shutdown.signal,
      onStart: (run, activeCount) => {
        console.log(
          `[worker] started run=${run.id} slots=${activeCount}/${maxConcurrency}`,
        );
      },
    });
  } finally {
    if (lockHeartbeat) clearInterval(lockHeartbeat);
    lock.release(true);
    await closeIoPgPool();
  }
}

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
  await closeIoPgPool();
});
