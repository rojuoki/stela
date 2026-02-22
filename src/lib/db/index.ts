import Database from "better-sqlite3";
import path from "path";
import { SCHEMA_SQL } from "./schema";

const DB_PATH = process.env.DATABASE_PATH || "./stela.sqlite";

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(path.resolve(DB_PATH));
    _db.pragma("journal_mode = WAL");
    _db.pragma("foreign_keys = ON");
    applySchema(_db);
    runMigrations(_db);
  }
  return _db;
}

function applySchema(db: Database.Database): void {
  db.exec(SCHEMA_SQL);
}

/**
 * Apply incremental schema migrations for existing databases.
 * Each migration is idempotent (checked before applying).
 */
function runMigrations(db: Database.Database): void {
  const cols = db.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>;

  // M-001: add resume_at column to jobs (TokenPool / WAITING_RATE_LIMIT support)
  if (!cols.some((c) => c.name === "resume_at")) {
    db.prepare("ALTER TABLE jobs ADD COLUMN resume_at TEXT").run();
    console.log("[db] Migration M-001: added jobs.resume_at");
  }

  // M-002: add resume_state column to jobs (checkpoint-based resume after 429)
  if (!cols.some((c) => c.name === "resume_state")) {
    db.prepare("ALTER TABLE jobs ADD COLUMN resume_state TEXT").run();
    console.log("[db] Migration M-002: added jobs.resume_state");
  }

  // M-003: make unlocks.job_id nullable (drop FK + NOT NULL).
  // Fixes cache-hit unlock recording which passed sentinel strings, not real job IDs.
  const unlockCols = db.prepare("PRAGMA table_info(unlocks)").all() as Array<{
    name: string; notnull: number;
  }>;
  const jobIdCol = unlockCols.find((c) => c.name === "job_id");
  if (jobIdCol && jobIdCol.notnull === 1) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE unlocks_new (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id     TEXT NOT NULL DEFAULT 'anonymous',
          account_id  TEXT NOT NULL,
          job_id      TEXT,
          unlocked_at TEXT NOT NULL,
          UNIQUE(user_id, account_id)
        );
        INSERT INTO unlocks_new SELECT * FROM unlocks;
        DROP TABLE unlocks;
        ALTER TABLE unlocks_new RENAME TO unlocks;
      `);
    })();
    console.log("[db] Migration M-003: made unlocks.job_id nullable");
  }
}
