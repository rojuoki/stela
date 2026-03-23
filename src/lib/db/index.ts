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

  // M-004: add node_pid column to jobs (HMR vs true-crash detection in _init())
  if (!cols.some((c) => c.name === "node_pid")) {
    db.prepare("ALTER TABLE jobs ADD COLUMN node_pid INTEGER").run();
    console.log("[db] Migration M-004: added jobs.node_pid");
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

  // M-005: add stage column to jobs table (Phase 4: Stage-aware excavation)
  if (!cols.some((c) => c.name === "stage")) {
    db.prepare("ALTER TABLE jobs ADD COLUMN stage INTEGER NOT NULL DEFAULT 1").run();
    console.log("[db] Migration M-005: added jobs.stage for stage-aware excavation");
  }

  // M-006: add stage column to unlocks table and update UNIQUE constraint (Phase 3: Stage-aware unlock tracking)
  const unlockCols2 = db.prepare("PRAGMA table_info(unlocks)").all() as Array<{ name: string }>;
  if (!unlockCols2.some((c) => c.name === "stage")) {
    db.transaction(() => {
      // Create new table with stage column and updated UNIQUE constraint
      db.exec(`
        CREATE TABLE unlocks_stage (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id     TEXT NOT NULL DEFAULT 'anonymous',
          account_id  TEXT NOT NULL,
          stage       INTEGER NOT NULL DEFAULT 1,
          job_id      TEXT,
          unlocked_at TEXT NOT NULL,
          UNIQUE(user_id, account_id, stage)
        );
        INSERT INTO unlocks_stage (id, user_id, account_id, stage, job_id, unlocked_at)
        SELECT id, user_id, account_id, 1, job_id, unlocked_at FROM unlocks;
        DROP TABLE unlocks;
        ALTER TABLE unlocks_stage RENAME TO unlocks;
        CREATE INDEX IF NOT EXISTS idx_unlocks_user_account ON unlocks(user_id, account_id);
      `);
    })();
    console.log("[db] Migration M-006: added unlocks.stage and updated UNIQUE constraint for stage-aware unlocks");
  }

  // M-007: add temporary_unlocks table (Phase 2: guest user unlock results)
  const temporaryUnlocksExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='temporary_unlocks'"
  ).get();
  if (!temporaryUnlocksExists) {
    db.exec(`
      CREATE TABLE temporary_unlocks (
        token       TEXT PRIMARY KEY,
        account_id  TEXT NOT NULL,
        username    TEXT NOT NULL,
        tweets_json TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        expires_at  TEXT NOT NULL,
        consumed    INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX idx_temporary_unlocks_expires ON temporary_unlocks(expires_at);
      CREATE INDEX idx_temporary_unlocks_consumed ON temporary_unlocks(consumed);
    `);
    console.log("[db] Migration M-007: added temporary_unlocks table for guest user results");
  }

  // M-008: add boundary_end and granted_count columns to unlocks (Phase 6: boundary model)
  const unlockCols3 = db.prepare("PRAGMA table_info(unlocks)").all() as Array<{ name: string }>;
  if (!unlockCols3.some((c) => c.name === "boundary_end")) {
    db.prepare("ALTER TABLE unlocks ADD COLUMN boundary_end INTEGER NOT NULL DEFAULT 0").run();
    console.log("[db] Migration M-008a: added unlocks.boundary_end");
  }
  if (!unlockCols3.some((c) => c.name === "granted_count")) {
    db.prepare("ALTER TABLE unlocks ADD COLUMN granted_count INTEGER NOT NULL DEFAULT 0").run();
    console.log("[db] Migration M-008b: added unlocks.granted_count");
  }

  // M-009: add user_id column to jobs (fix unlock user_id bug)
  const jobCols2 = db.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>;
  if (!jobCols2.some((c) => c.name === "user_id")) {
    db.prepare("ALTER TABLE jobs ADD COLUMN user_id TEXT NOT NULL DEFAULT 'anonymous'").run();
    console.log("[db] Migration M-009: added jobs.user_id for unlock user tracking");
  }
}
