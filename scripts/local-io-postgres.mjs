import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync } from "node:fs";
import net from "node:net";
import path from "node:path";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const wait = (milliseconds) => new Promise(resolve => setTimeout(resolve, milliseconds));

function executable(name) {
  const configured = process.env.STELA_IO_POSTGRES_BIN;
  const candidates = [];
  if (configured) candidates.push(path.join(configured, name));
  const pgConfig = spawnSync("pg_config", ["--bindir"], { encoding: "utf8" });
  if (pgConfig.status === 0 && pgConfig.stdout.trim()) {
    candidates.push(path.join(pgConfig.stdout.trim(), name));
  }
  candidates.push(
    `/opt/homebrew/opt/postgresql@18/bin/${name}`,
    `/opt/homebrew/opt/postgresql/bin/${name}`,
    `/usr/local/opt/postgresql@18/bin/${name}`,
    name,
  );
  for (const candidate of candidates) {
    if (candidate === name) return candidate;
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return name;
}

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: process.cwd(), env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${path.basename(command)} exited with status ${result.status}`);
  }
}

function portIsOpen(host, port) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host, port });
    const finish = value => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(250);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

export async function startLocalIoPostgres() {
  const raw = process.env.STELA_IO_DATABASE_URL;
  if (!raw) throw new Error("STELA_IO_DATABASE_URL is not set in .env.local");
  const url = new URL(raw);
  const port = Number(url.port || 5432);
  const host = url.hostname;
  if (
    process.env.STELA_IO_MANAGE_LOCAL_POSTGRES === "0"
    || !LOCAL_HOSTS.has(host)
  ) {
    console.log("[stela] Using configured external IO PostgreSQL");
    return { managed: false, stop: async () => {} };
  }
  if (await portIsOpen(host, port)) {
    console.log(`[stela] Using existing IO PostgreSQL at ${host}:${port}`);
    return { managed: false, stop: async () => {} };
  }

  const root = path.resolve(process.env.STELA_IO_DEV_PG_ROOT || ".local/io-postgres");
  const dataDirectory = path.join(root, "data");
  const socketDirectory = path.join(root, "socket");
  mkdirSync(root, { recursive: true });
  mkdirSync(socketDirectory, { recursive: true });
  if (!existsSync(path.join(dataDirectory, "PG_VERSION"))) {
    console.log(`[stela] Initializing persistent IO PostgreSQL at ${dataDirectory}`);
    run(executable("initdb"), [
      "-D", dataDirectory,
      "-U", decodeURIComponent(url.username || "postgres"),
      "-A", "trust",
      "--no-locale",
    ]);
  }

  console.log(`[stela] Starting persistent IO PostgreSQL at ${host}:${port}`);
  const postgres = spawn(executable("postgres"), [
    "-D", dataDirectory,
    "-h", host,
    "-k", socketDirectory,
    "-p", String(port),
  ], { cwd: process.cwd(), env: process.env, stdio: "inherit" });
  let exit;
  postgres.once("exit", code => { exit = code ?? 1; });
  postgres.once("error", error => { console.error("[stela] Cannot launch local PostgreSQL", error); });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await portIsOpen(host, port)) break;
    if (exit !== undefined) throw new Error(`Local PostgreSQL exited with status ${exit}`);
    await wait(100);
  }
  if (!(await portIsOpen(host, port))) {
    postgres.kill("SIGTERM");
    throw new Error("Local PostgreSQL did not become ready within 10 seconds");
  }

  let stopped = false;
  return {
    managed: true,
    dataDirectory,
    async stop() {
      if (stopped || postgres.exitCode !== null) return;
      stopped = true;
      console.log("[stela] Stopping local IO PostgreSQL; data remains on disk");
      const exited = new Promise(resolve => postgres.once("exit", resolve));
      postgres.kill("SIGTERM");
      await Promise.race([exited, wait(10_000)]);
      if (postgres.exitCode === null) postgres.kill("SIGKILL");
    },
  };
}

export function migrateLocalIoPostgres() {
  console.log("[stela] Applying and verifying IO PostgreSQL migrations");
  run(process.execPath, ["--import", "tsx", "scripts/migrate-io-postgres.ts"]);
  run(process.execPath, ["--import", "tsx", "scripts/verify-io-postgres.ts"]);
}
