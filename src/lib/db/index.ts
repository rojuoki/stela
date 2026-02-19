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
  // M-001: add resume_at column to jobs (TokenPool / WAITING_RATE_LIMIT support)
  const cols = db.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "resume_at")) {
    db.prepare("ALTER TABLE jobs ADD COLUMN resume_at TEXT").run();
    console.log("[db] Migration M-001: added jobs.resume_at");
  }
}
