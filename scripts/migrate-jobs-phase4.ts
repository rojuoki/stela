/**
 * Phase 4 Migration Script: Add stage column to jobs table
 * 
 * This script adds stage-awareness to the jobs table to support Stage 2/3 excavation.
 * 
 * Changes:
 * 1. Add 'stage' column (defaults to 1 for existing records)
 * 2. All existing jobs are considered Stage 1 jobs
 * 
 * Run: npx tsx scripts/migrate-jobs-phase4.ts
 */
import Database from "better-sqlite3";
import path from "path";

const DB_PATH = process.env.DATABASE_PATH || "./stela.sqlite";
const db = new Database(path.resolve(DB_PATH));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

console.log("🔄 Starting Phase 4 jobs migration...");

try {
  db.transaction(() => {
    // Check if migration is needed (stage column doesn't exist)
    const columns = db.prepare("PRAGMA table_info(jobs)").all() as Array<{name: string}>;
    const hasStageColumn = columns.some(col => col.name === 'stage');
    
    if (hasStageColumn) {
      console.log("✓ Migration already applied - stage column exists in jobs table");
      return;
    }
    
    console.log("📋 Current jobs table schema:");
    columns.forEach(col => console.log(`  - ${col.name}`));
    
    // Count existing job records
    const existingCount = db.prepare("SELECT COUNT(*) as count FROM jobs").get() as {count: number};
    console.log(`📊 Found ${existingCount.count} existing job records`);
    
    // Add stage column with default value 1
    console.log("🔨 Adding stage column to jobs table...");
    db.exec(`ALTER TABLE jobs ADD COLUMN stage INTEGER NOT NULL DEFAULT 1;`);
    
    // Verify migration
    const newColumns = db.prepare("PRAGMA table_info(jobs)").all() as Array<{name: string}>;
    const stageColumnAdded = newColumns.some(col => col.name === 'stage');
    
    if (!stageColumnAdded) {
      throw new Error("Failed to add stage column to jobs table");
    }
    
    // Count records that got the default stage value
    const stage1Jobs = db.prepare("SELECT COUNT(*) as count FROM jobs WHERE stage = 1").get() as {count: number};
    console.log(`✓ Migration complete: ${stage1Jobs.count} jobs marked as Stage 1`);
    
    if (stage1Jobs.count !== existingCount.count) {
      throw new Error(`Migration data mismatch: expected ${existingCount.count} Stage 1 jobs, got ${stage1Jobs.count}`);
    }
    
  })();
  
  console.log("✅ Phase 4 migration completed successfully!");
  
} catch (error) {
  console.error("❌ Migration failed:", error);
  process.exit(1);
} finally {
  db.close();
}