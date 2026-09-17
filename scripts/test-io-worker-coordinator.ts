import assert from "node:assert/strict";
import { runWorkerCoordinator } from "../src/lib/io/worker-coordinator";

function waitFor(predicate: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > 2_000) {
        clearInterval(timer);
        reject(new Error("Timed out waiting for worker coordinator state"));
      }
    }, 5);
  });
}

async function main(): Promise<void> {
  const queued = Array.from({ length: 10 }, (_, index) => index + 1);
  const releases = new Map<number, () => void>();
  const started: number[] = [];
  let active = 0;
  let maximumActive = 0;
  const abort = new AbortController();

  const coordinator = runWorkerCoordinator({
    concurrency: 8,
    claim: async () => queued.shift() ?? null,
    process: async (job) => {
      started.push(job);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => releases.set(job, resolve));
      active -= 1;
      if (started.length === 10 && active === 0) abort.abort();
    },
    idleWait: async () => undefined,
    signal: abort.signal,
  });

  await waitFor(() => started.length === 8);
  assert.equal(maximumActive, 8);
  assert.deepEqual(started, [1, 2, 3, 4, 5, 6, 7, 8]);

  releases.get(1)?.();
  await waitFor(() => started.length === 9);
  assert.equal(started[8], 9, "the first free slot should claim the next job");

  for (const job of started.slice(1)) releases.get(job)?.();
  await waitFor(() => started.length === 10);
  releases.get(10)?.();
  await coordinator;

  assert.equal(maximumActive, 8);
  assert.equal(active, 0);
  assert.deepEqual(started, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  console.log("IO worker coordinator 8-slot refill invariant passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
