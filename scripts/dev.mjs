import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { migrateLocalIoPostgres, startLocalIoPostgres } from "./local-io-postgres.mjs";

const require = createRequire(import.meta.url);
require("@next/env").loadEnvConfig(process.cwd(), true);
const webOnly = process.argv.includes("--web-only");
const nextArguments = process.argv.slice(2).filter(argument => argument !== "--web-only");
const hasBundlerArgument = nextArguments.some(argument =>
  argument === "--webpack" || argument === "--turbo" || argument === "--turbopack"
);
const webArguments = hasBundlerArgument ? nextArguments : ["--webpack", ...nextArguments];

let stopping = false;
let web;
let worker;
let database;
let retry;
let failures = 0;

async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  clearTimeout(retry);
  process.exitCode = code;
  web?.kill("SIGTERM");
  worker?.kill("SIGTERM");
  const deadline = setTimeout(() => {
    web?.kill("SIGKILL");
    worker?.kill("SIGKILL");
  }, 15_000);
  deadline.unref();
  await database?.stop();
}

function startWorker() {
  if (stopping) return;
  console.log("[stela] Starting IO worker alongside the web server");
  const started = Date.now();
  worker = spawn(process.execPath, ["--import", "tsx", "scripts/io-local-worker.ts"], { stdio: "inherit" });
  worker.on("error", () => { console.error("[stela] Cannot launch IO worker"); void stop(1); });
  worker.on("exit", () => {
    if (stopping) return;
    failures = Date.now() - started > 60_000 ? 1 : failures + 1;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(failures, 5));
    console.error(`[stela] IO worker exited; restarting in ${delay / 1000}s`);
    retry = setTimeout(startWorker, delay);
  });
}

async function main() {
  database = await startLocalIoPostgres();
  migrateLocalIoPostgres();
  const webEnvironment = { ...process.env, STELA_IO_WEB_ONLY: webOnly ? "1" : "0" };
  web = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "dev", ...webArguments], {
    env: webEnvironment,
    stdio: ["inherit", "pipe", "pipe"],
  });
  web.stdout.on("data", chunk => process.stdout.write(chunk));
  web.stderr.on("data", chunk => process.stderr.write(chunk));
  web.on("error", () => { void stop(1); });
  web.on("exit", code => { void stop(code ?? 1); });
  if (webOnly) console.log("[stela] Web-only mode; acquisition worker is not running");
  else startWorker();
}

process.on("SIGINT", () => { void stop(); });
process.on("SIGTERM", () => { void stop(); });
main().catch(async error => {
  console.error("[stela] Development stack could not start", error);
  await stop(1);
});
