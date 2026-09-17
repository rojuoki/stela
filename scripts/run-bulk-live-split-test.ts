import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { excavateBulk } from "../src/lib/excavateBulk";
import { getPgPool } from "../src/lib/db";

const accounts = ["nasa", "elonmusk", "cnn"];
const continuationStart = "2025-01-01T00:00:00.000Z";
const targetCount = 1_000;

type RunRecord = {
  username: string;
  continuationStart: string;
  targetCount: number;
  elapsedMs: number;
  splitCount: number;
  discardedParentTweets: number;
  result: Awaited<ReturnType<typeof excavateBulk>>;
};

async function main() {
  const records: RunRecord[] = [];
  const originalLog = console.log;

  try {
    for (const username of accounts) {
      let splitCount = 0;
      let discardedParentTweets = 0;

      console.log = (...args: unknown[]) => {
        const first = args[0];
        if (typeof first === "string" && first.startsWith("[bulk-collect][split]")) {
          splitCount++;
          const discarded = /discarding (\d+) parent tweets/.exec(first);
          discardedParentTweets += Number(discarded?.[1] ?? 0);
        }
        originalLog(...args);
      };

      originalLog(`\n[live-bulk-test] @${username} starting`);
      const startedAt = performance.now();
      const result = await excavateBulk(
        username,
        targetCount,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        continuationStart,
      );
      const elapsedMs = Math.round(performance.now() - startedAt);
      records.push({
        username,
        continuationStart,
        targetCount,
        elapsedMs,
        splitCount,
        discardedParentTweets,
        result,
      });
      originalLog(
        `[live-bulk-test] @${username} done: ${result.stopReason}, ` +
          `${result.fetchedCount} fetched, ${result.apiCalls} calls, ` +
          `${splitCount} splits, ${(elapsedMs / 1000).toFixed(1)}s`,
      );
    }
  } finally {
    console.log = originalLog;
    await getPgPool().end();
  }

  const output = {
    experiment: "bulk_live_split_test",
    createdAt: new Date().toISOString(),
    records,
  };
  const directory = path.join(process.cwd(), "results", "bulk-live-split-tests");
  await mkdir(directory, { recursive: true });
  const filename = `bulk-split-${output.createdAt.replaceAll(":", "-")}.json`;
  const outputPath = path.join(directory, filename);
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  console.log(`[live-bulk-test] wrote ${outputPath}`);
}

main().catch((error) => {
  console.error("[live-bulk-test] failed", error);
  process.exitCode = 1;
});
