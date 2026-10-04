const RETRYABLE_STATUS = new Set([502, 503, 504]);

export interface IoWorkerWakeResult {
  configured: boolean;
  delivered: boolean;
  attempts: number;
}

interface IoWorkerWakeOptions {
  url?: string;
  secret?: string;
  fetchImpl?: typeof fetch;
  retryWait?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
  attempts?: number;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Best-effort notification after a run has been committed to Postgres.
 * Delivery failure never invalidates the queued run: the recovery cron is the
 * durable fallback.
 */
export async function wakeIoWorker(
  source: string,
  options: IoWorkerWakeOptions = {},
): Promise<IoWorkerWakeResult> {
  const url = options.url ?? process.env.STELA_IO_WORKER_WAKE_URL;
  const secret = options.secret ?? process.env.STELA_IO_WORKER_WAKE_SECRET;
  if (!url || !secret) {
    console.error("[worker-wake] notification is not configured; recovery cron must claim the queued run");
    return { configured: false, delivered: false, attempts: 0 };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const retryWait = options.retryWait ?? wait;
  const timeoutMs = Math.max(250, options.timeoutMs ?? 4_000);
  const attemptLimit = Math.max(1, options.attempts ?? 3);
  let lastFailure = "unknown failure";
  let attemptsMade = 0;

  for (let attempt = 1; attempt <= attemptLimit; attempt += 1) {
    attemptsMade = attempt;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-stela-worker-secret": secret,
        },
        body: JSON.stringify({ source }),
        cache: "no-store",
        signal: controller.signal,
      });
      if (response.ok) {
        return { configured: true, delivered: true, attempts: attempt };
      }
      lastFailure = `HTTP ${response.status}`;
      if (!RETRYABLE_STATUS.has(response.status)) break;
    } catch (error) {
      lastFailure = error instanceof Error ? error.name : "network error";
    } finally {
      clearTimeout(timeout);
    }
    if (attempt < attemptLimit) await retryWait(250 * attempt);
  }

  console.error(`[worker-wake] notification failed (${lastFailure}); recovery cron will claim the queued run`);
  return { configured: true, delivered: false, attempts: attemptsMade };
}
