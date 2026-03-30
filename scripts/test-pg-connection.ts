/**
 * Test Postgres connection to Neon
 * Run: npx tsx scripts/test-pg-connection.ts
 */
import { testPgConnection, getPgPool } from "../src/lib/db/index";

async function main() {
  console.log("Testing Postgres connection to Neon...");
  console.log("DATABASE_URL:", process.env.DATABASE_URL ? "✅ Set" : "❌ Not set");
  
  try {
    const success = await testPgConnection();
    if (success) {
      console.log("✅ Postgres connection successful!");
    } else {
      console.log("❌ Postgres connection failed");
      process.exit(1);
    }
    
    // Clean shutdown
    const pool = getPgPool();
    await pool.end();
    console.log("✅ Connection pool closed");
    
  } catch (error) {
    console.error("❌ Connection test error:", error);
    process.exit(1);
  }
}

main().catch(console.error);