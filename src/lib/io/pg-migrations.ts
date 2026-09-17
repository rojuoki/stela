import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ioPgQuery, withIoPgTransaction } from "./pg-db";

export interface IoMigrationResult {
  applied: string[];
  skipped: string[];
}

function migrationsDirectory(): string {
  return path.join(process.cwd(), "migrations", "io");
}

function checksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

function migrationFiles(): string[] {
  const directory = migrationsDirectory();
  return fs.readdirSync(directory)
    .filter((file) => /^\d+_.+\.sql$/.test(file))
    .sort((left, right) => left.localeCompare(right));
}

export async function runIoPgMigrations(): Promise<IoMigrationResult> {
  await ioPgQuery(`
    CREATE TABLE IF NOT EXISTS io_schema_migrations (
      name TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const applied: string[] = [];
  const skipped: string[] = [];
  for (const name of migrationFiles()) {
    const sql = fs.readFileSync(path.join(migrationsDirectory(), name), "utf8");
    const digest = checksum(sql);
    const existing = await ioPgQuery<{ checksum: string }>(
      "SELECT checksum FROM io_schema_migrations WHERE name = $1",
      [name],
    );
    if (existing.rowCount) {
      if (existing.rows[0].checksum !== digest) {
        throw new Error(`Migration ${name} was changed after it was applied`);
      }
      skipped.push(name);
      continue;
    }
    await withIoPgTransaction(async (client) => {
      await client.query(sql);
      await client.query(
        "INSERT INTO io_schema_migrations (name, checksum) VALUES ($1, $2)",
        [name, digest],
      );
    });
    applied.push(name);
  }
  return { applied, skipped };
}
