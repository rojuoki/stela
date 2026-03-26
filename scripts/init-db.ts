/**
 * Standalone script to create/initialize the SQLite database.
 * Run: npx tsx scripts/init-db.ts
 */
import Database from "better-sqlite3";
import path from "path";
import { SCHEMA_SQL } from "../src/lib/db/schema";

const DB_PATH = process.env.DATABASE_PATH || "./stela.sqlite";
const db = new Database(path.resolve(DB_PATH));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(SCHEMA_SQL);

// Add description column to existing accounts table (safe - does nothing if column exists)
try {
  db.exec("ALTER TABLE accounts ADD COLUMN description TEXT");
  console.log("✓ Added description column to accounts table");
} catch (e) {
  // Column already exists - ignore
}

console.log(`✓ Database initialized at ${DB_PATH}`);
db.close();
