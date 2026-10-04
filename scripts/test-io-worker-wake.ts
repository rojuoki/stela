import assert from "node:assert/strict";
import { once } from "node:events";
import { createIoWorkerWakeServer } from "../src/lib/io/worker-wake-server";
import { wakeIoWorker } from "../src/lib/io/worker-wake";

async function main(): Promise<void> {
  let wakeCount = 0;
  let running = false;
  const server = createIoWorkerWakeServer({
    secret: "test-secret",
    isRunning: () => running,
    wake: () => {
      wakeCount += 1;
      const alreadyRunning = running;
      running = true;
      return { alreadyRunning };
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/wake`;

  try {
    const unauthorized = await fetch(url, { method: "POST" });
    assert.equal(unauthorized.status, 401);
    assert.equal(wakeCount, 0);

    const delivered = await wakeIoWorker("test", {
      url,
      secret: "test-secret",
      attempts: 1,
    });
    assert.deepEqual(delivered, { configured: true, delivered: true, attempts: 1 });
    assert.equal(wakeCount, 1);

    const duplicate = await wakeIoWorker("test", {
      url,
      secret: "test-secret",
      attempts: 1,
    });
    assert.equal(duplicate.delivered, true);
    assert.equal(wakeCount, 2);

    const health = await fetch(url.replace("/wake", "/health"));
    assert.deepEqual(await health.json(), { ok: true, running: true });

    let attempts = 0;
    const retried = await wakeIoWorker("retry-test", {
      url,
      secret: "test-secret",
      attempts: 3,
      retryWait: async () => undefined,
      fetchImpl: async (...args) => {
        attempts += 1;
        if (attempts === 1) return new Response(null, { status: 502 });
        return fetch(...args);
      },
    });
    assert.equal(retried.delivered, true);
    assert.equal(retried.attempts, 2);
    console.log("IO worker wake authentication, delivery, health, and cold-start retry passed");
  } finally {
    server.close();
    await once(server, "close");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
