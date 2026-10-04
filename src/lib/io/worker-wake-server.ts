import { timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";

export interface IoWorkerWakeServerOptions {
  secret: string;
  wake: () => { alreadyRunning: boolean };
  isRunning: () => boolean;
}

function authorized(actual: string | string[] | undefined, expected: string): boolean {
  if (typeof actual !== "string") return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length
    && timingSafeEqual(actualBytes, expectedBytes);
}

function respond(
  response: import("node:http").ServerResponse,
  status: number,
  payload: Record<string, unknown>,
): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

export function createIoWorkerWakeServer(options: IoWorkerWakeServerOptions): Server {
  if (!options.secret) throw new Error("STELA_IO_WORKER_WAKE_SECRET is required in HTTP worker mode");
  const server = createServer((request, response) => {
    const path = new URL(request.url || "/", "http://worker.internal").pathname;
    if (request.method === "GET" && path === "/health") {
      respond(response, 200, { ok: true, running: options.isRunning() });
      return;
    }
    if (request.method === "POST" && path === "/wake") {
      if (!authorized(request.headers["x-stela-worker-secret"], options.secret)) {
        respond(response, 401, { error: "Unauthorized" });
        return;
      }
      request.resume();
      const result = options.wake();
      respond(response, 202, { accepted: true, alreadyRunning: result.alreadyRunning });
      return;
    }
    respond(response, 404, { error: "Not found" });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 10_000;
  return server;
}
