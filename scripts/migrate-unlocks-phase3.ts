/**
 * Phase 3 Migration Script: Make unlocks table stage-aware
 * 
 * This script migrates the existing unlocks table to support stage-based unlocks.
 * 
 * Changes:
 * 1. Add 'stage' column (defaults to 1 for existing records)
 * 2. Update UNIQUE constraint to (user_id, account_id, stage)
 * 3. Add index for performance
 * 
 * Run: npx tsx scripts/migrate-unlocks-phase3.ts
 */
import Database from "better-sqlite3";
import path from "path";

const DB_PATH = process.env.DATABASE_PATH || "./stela.sqlite";
const db = new Database(path.resolve(DB_PATH));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

console.log("🔄 Starting Phase 3 unlocks migration...");

try {
  db.transaction(() => {
    // Check if migration is needed (stage column doesn't exist)
    const columns = db.prepare("PRAGMA table_info(unlocks)").all() as Array<{name: string}>;
    const hasStageColumn = columns.some(col => col.name === 'stage');
    
    if (hasStageColumn) {
      console.log("✓ Migration already applied - stage column exists");
      return;
    }
    
    console.log("📋 Current unlocks table schema:");
    columns.forEach(col => console.log(`  - ${col.name}`));
    
    // Count existing unlock records
    const existingCount = db.prepare("SELECT COUNT(*) as count FROM unlocks").get() as {count: number};
    console.log(`📊 Found ${existingCount.count} existing unlock records`);
    
    // Step 1: Create new table with stage column
    console.log("🔨 Creating new unlocks table with stage column...");
    db.exec(`
      CREATE TABLE unlocks_new (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id       TEXT NOT NULL DEFAULT 'anonymous',
        account_id    TEXT NOT NULL,
        stage         INTEGER NOT NULL DEFAULT 1,
        job_id        TEXT,
        unlocked_at   TEXT NOT NULL,
        UNIQUE(user_id, account_id, stage)
      );
    `);
    
    // Step 2: Copy existing data (all records become Stage 1)
    console.log("📋 Copying existing unlock records as Stage 1 unlocks...");
    db.exec(`
      INSERT INTO unlocks_new (id, user_id, account_id, stage, job_id, unlocked_at)
      SELECT id, user_id, account_id, 1, job_id, unlocked_at
      FROM unlocks;
    `);
    
    // Step 3: Replace old table
    console.log("🔄 Replacing old table...");
    db.exec(`DROP TABLE unlocks;`);
    db.exec(`ALTER TABLE unlocks_new RENAME TO unlocks;`);
    
    // Step 4: Create index for performance
    console.log("📇 Creating index...");
    db.exec(`CREATE INDEX IF NOT EXISTS idx_unlocks_user_account ON unlocks(user_id, account_id);`);
    
    // Verify migration
    const newCount = db.prepare("SELECT COUNT(*) as count FROM unlocks WHERE stage = 1").get() as {count: number};
    console.log(`✓ Migration complete: ${newCount.count} Stage 1 unlock records`);
    
    if (newCount.count !== existingCount.count) {
      throw new Error(`Migration data mismatch: expected ${existingCount.count}, got ${newCount.count}`);
    }
    
  })();
  
  console.log("✅ Phase 3 migration completed successfully!");
  
} catch (error) {
  console.error("❌ Migration failed:", error);
  process.exit(1);
} finally {
  db.close();
}