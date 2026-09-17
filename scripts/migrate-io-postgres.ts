import { closeIoPgPool } from "../src/lib/io/pg-db";
import { runIoPgMigrations } from "../src/lib/io/pg-migrations";

async function main() {
  try {
    const result = await runIoPgMigrations();
    for (const name of result.applied) console.log(`applied ${name}`);
    for (const name of result.skipped) console.log(`current ${name}`);
  } finally {
    await closeIoPgPool();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
