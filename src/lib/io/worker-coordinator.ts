export interface WorkerCoordinatorOptions<T> {
  concurrency: number;
  claim: () => Promise<T | null>;
  process: (item: T) => Promise<void>;
  idleWait: () => Promise<void>;
  once?: boolean;
  signal?: AbortSignal;
  onStart?: (item: T, activeCount: number) => void;
}

/**
 * Keeps at most `concurrency` jobs active and refills a slot as soon as one
 * finishes. The database claim function remains responsible for cross-process
 * locking; this coordinator only owns the slots inside one worker process.
 */
export async function runWorkerCoordinator<T>(
  options: WorkerCoordinatorOptions<T>,
): Promise<void> {
  const concurrency = Math.max(1, Math.floor(options.concurrency));
  const active = new Set<Promise<void>>();

  const launchAvailable = async (): Promise<void> => {
    while (!options.signal?.aborted && active.size < concurrency) {
      const item = await options.claim();
      if (!item) return;

      const task = options.process(item).finally(() => {
        active.delete(task);
      });
      active.add(task);
      options.onStart?.(item, active.size);
    }
  };

  try {
    while (!options.signal?.aborted) {
      await launchAvailable();

      if (options.once) {
        await Promise.all(active);
        return;
      }

      if (active.size === 0) {
        await options.idleWait();
      } else {
        await Promise.race(active);
      }
    }
  } finally {
    await Promise.allSettled(active);
  }
}
