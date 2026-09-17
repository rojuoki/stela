import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import {
  importAcquisitionProgress,
  importAcquisitionResult,
} from "./import-result";
import {
  acquisitionProviderLabel,
  type AcquisitionProvider,
} from "./providers";
import {
  createIoRun,
  getActiveIoRun,
  getAnyActiveIoRun,
  getIoRun,
  updateIoRun,
  type IoRun,
} from "./repository";

interface JobState {
  child: ChildProcess | null;
  runId: string | null;
}

const globalJobs = globalThis as typeof globalThis & {
  __stelaIoJobState?: JobState;
};
const jobState =
  globalJobs.__stelaIoJobState || (globalJobs.__stelaIoJobState = { child: null, runId: null });

function conciseLine(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 500);
}

function consumeLines(
  chunk: Buffer,
  remainder: string,
  onLine: (line: string) => void,
): string {
  const parts = `${remainder}${chunk.toString("utf8")}`.split(/\r?\n/);
  const tail = parts.pop() || "";
  for (const part of parts) {
    const line = conciseLine(part);
    if (line) onLine(line);
  }
  return tail;
}

function runInBackground(run: IoRun): void {
  const projectRoot = process.cwd();
  const provider = run.provider as AcquisitionProvider;
  const isTwscrape = provider === "twscrape";
  const scriptPath = path.join(
    projectRoot,
    isTwscrape
      ? "scripts/measure_twscrape_1000.py"
      : "scripts/measure_twitterapi_io_1000.py",
  );
  const outputPath = run.output_path!;
  const progressPath = `${outputPath}.progress.json`;
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const python = isTwscrape
    ? process.env.STELA_TWSCRAPE_PYTHON || process.env.STELA_IO_PYTHON || "python3"
    : process.env.STELA_IO_PYTHON || "python3";
  const args = [
    scriptPath,
    run.username,
    "--target-count",
    String(run.target_count || 1000),
    "--output",
    outputPath,
  ];
  if (run.collection_mode === "prefix_extend") {
    if (isTwscrape || !run.requested_start_at) {
      updateIoRun(run.id, {
        status: "failed",
        progress_message: "Invalid prefix extension run",
        error_message: "prefix_extend requires TwitterAPI.io and requested_start_at",
        finished_at: new Date().toISOString(),
      });
      return;
    }
    args.push(
      "--collection-mode",
      "prefix_extend",
      "--collect-start",
      run.requested_start_at,
    );
  }
  if (isTwscrape) {
    args.push(
      "--max-requests",
      process.env.STELA_TWSCRAPE_MAX_REQUESTS || "2000",
    );
    if (process.env.STELA_TWSCRAPE_DB) {
      args.push("--db", process.env.STELA_TWSCRAPE_DB);
    }
  } else {
    args.push(
      "--request-interval",
      process.env.STELA_IO_REQUEST_INTERVAL || "0.7",
      "--progress-output",
      progressPath,
    );
    if (process.env.STELA_IO_MAX_REQUESTS) {
      args.push("--max-requests", process.env.STELA_IO_MAX_REQUESTS);
    }
    if (process.env.STELA_IO_MAX_ESTIMATED_COST_USD) {
      args.push("--max-estimated-cost-usd", process.env.STELA_IO_MAX_ESTIMATED_COST_USD);
    }
  }
  const child = spawn(python, args, {
    cwd: projectRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  jobState.child = child;
  jobState.runId = run.id;
  updateIoRun(run.id, {
    status: "running",
    progress_message: `Starting ${acquisitionProviderLabel(provider)} acquisition`,
    started_at: new Date().toISOString(),
  });

  let stdoutTail = "";
  let stderrTail = "";
  const recentErrors: string[] = [];
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutTail = consumeLines(chunk, stdoutTail, (line) => {
      if (line.startsWith("PROGRESS ")) {
        try {
          importAcquisitionProgress(progressPath, run.id, provider);
        } catch (error) {
          updateIoRun(run.id, {
            progress_message: "Progress snapshot is not ready yet",
            error_message: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }
      updateIoRun(run.id, { progress_message: line });
    });
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrTail = consumeLines(chunk, stderrTail, (line) => {
      recentErrors.push(line);
      if (recentErrors.length > 5) recentErrors.shift();
    });
  });

  child.on("error", (error) => {
    updateIoRun(run.id, {
      status: "failed",
      progress_message: "Could not start acquisition process",
      error_message: error.message,
      finished_at: new Date().toISOString(),
    });
    jobState.child = null;
    jobState.runId = null;
  });

  child.on("close", (code) => {
    const finalError = conciseLine(`${stderrTail} ${recentErrors.join(" ")}`);
    try {
      if (fs.existsSync(outputPath)) {
        importAcquisitionResult(outputPath, run.id, provider);
        if (code !== 0 && getIoRun(run.id)?.status === "succeeded") {
          updateIoRun(run.id, {
            status: "failed",
            progress_message: `Acquisition stopped (exit ${code ?? "unknown"})`,
            error_message: finalError || `Process exited with code ${code ?? "unknown"}`,
          });
        }
      } else {
        updateIoRun(run.id, {
          status: "failed",
          progress_message: `Acquisition stopped (exit ${code ?? "unknown"})`,
          error_message: finalError || `Process exited with code ${code ?? "unknown"}`,
          finished_at: new Date().toISOString(),
        });
      }
    } catch (error) {
      updateIoRun(run.id, {
        status: "failed",
        progress_message: "Result import failed",
        error_message: error instanceof Error ? error.message : String(error),
        finished_at: new Date().toISOString(),
      });
    } finally {
      jobState.child = null;
      jobState.runId = null;
    }
  });
}

export function startIoAcquisition(
  username: string,
  targetCount: number,
  provider: AcquisitionProvider = "twitterapi_io",
): { run: IoRun; reused: boolean } {
  const existing = getActiveIoRun(username);
  if (existing && jobState.runId === existing.id) {
    return { run: existing, reused: true };
  }
  if (existing) {
    updateIoRun(existing.id, {
      status: "failed",
      progress_message: "Interrupted when the local server stopped",
      error_message: "The in-process prototype worker is no longer running",
      finished_at: new Date().toISOString(),
    });
  }

  const active = getAnyActiveIoRun();
  if (active && jobState.runId !== active.id) {
    updateIoRun(active.id, {
      status: "failed",
      progress_message: "Interrupted when the local server stopped",
      error_message: "The in-process prototype worker is no longer running",
      finished_at: new Date().toISOString(),
    });
  }
  if (jobState.child || getAnyActiveIoRun()) {
    throw new Error(`Another acquisition is already running for @${active?.username || "unknown"}`);
  }

  const id = randomUUID();
  const outputPath = path.join(
    process.cwd(),
    `results/${provider.replaceAll("_", "-")}-ui`,
    `${username}-${id}.json`,
  );
  const run = createIoRun({
    id,
    username,
    provider,
    collectionMode: targetCount === 100 ? "target_100" : "target_1000",
    targetCount,
    outputPath,
  });
  jobState.runId = id;
  setImmediate(() => runInBackground(run));
  return { run: getIoRun(id)!, reused: false };
}

/** Starts only the unresolved suffix selected by the +1000 planner. */
export function startIoPrefixExtension(input: {
  username: string;
  provider: AcquisitionProvider;
  collectStartAt: string;
  baseBoundary: number;
  targetBoundary: number;
  acquisitionTargetCount: number;
}): { run: IoRun; reused: boolean } {
  if (input.provider !== "twitterapi_io") {
    throw new Error("prefix_extend currently requires TwitterAPI.io");
  }
  if (!Number.isFinite(Date.parse(input.collectStartAt))) {
    throw new Error("prefix_extend requires a valid coverage frontier");
  }
  if (!Number.isInteger(input.acquisitionTargetCount) || input.acquisitionTargetCount <= 0) {
    throw new Error("prefix_extend requires a positive missing count");
  }
  const active = getActiveIoRun(input.username);
  if (active) return { run: active, reused: true };
  if (jobState.child || getAnyActiveIoRun()) {
    throw new Error("Another acquisition is already running");
  }

  const id = randomUUID();
  const outputPath = path.join(
    process.cwd(),
    "results/twitterapi-io-ui",
    `${input.username}-${id}.json`,
  );
  const run = createIoRun({
    id,
    username: input.username,
    provider: input.provider,
    collectionMode: "prefix_extend",
    targetCount: input.acquisitionTargetCount,
    baseBoundary: input.baseBoundary,
    targetBoundary: input.targetBoundary,
    requestedStartAt: input.collectStartAt,
    outputPath,
  });
  jobState.runId = id;
  setImmediate(() => runInBackground(run));
  return { run: getIoRun(id)!, reused: false };
}
