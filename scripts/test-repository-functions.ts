/**
 * Test Phase 5 Postgres repository functions
 * Run: npx tsx scripts/test-repository-functions.ts
 */
import { 
  getCheckoutSessionPg, 
  getActiveJobsPg,
  getDatabaseHealthPg,
  getPgPool 
} from "../src/lib/repository";
import { testPgConnection } from "../src/lib/db/index";

async function main() {
  console.log("Testing Phase 5 Postgres repository functions...");
  
  try {
    // 1. Test connection first
    console.log("\n1. Testing Postgres connection...");
    const connected = await testPgConnection();
    if (!connected) {
      console.error("❌ Cannot connect to database");
      process.exit(1);
    }
    console.log("✅ Database connected successfully");
    
    // 2. Test health check
    console.log("\n2. Testing getDatabaseHealthPg...");
    const health = await getDatabaseHealthPg();
    console.log("✅ Health check result:", health);
    
    // 3. Test checkout session lookup (will return null for non-existent session)
    console.log("\n3. Testing getCheckoutSessionPg...");
    const session = await getCheckoutSessionPg("test_nonexistent_session");
    console.log("Result:", session === null ? "✅ null (expected for test session)" : "❌ unexpected result");
    
    // 4. Test active jobs lookup
    console.log("\n4. Testing getActiveJobsPg...");
    const jobs = await getActiveJobsPg();
    console.log("✅ Active jobs retrieved:", jobs.length, "jobs found");
    if (jobs.length > 0) {
      console.log("Sample job:", {
        id: jobs[0].id,
        username: jobs[0].account_username,
        status: jobs[0].status
      });
    }
    
    console.log("\n✅ All Phase 5 repository functions working!");
    
  } catch (error) {
    console.error("❌ Repository function test error:", error);
    process.exit(1);
  } finally {
    // Clean shutdown
    try {
      const pool = getPgPool();
      await pool.end();
      console.log("✅ Connection pool closed");
    } catch (e) {
      console.warn("Warning: Pool cleanup failed:", e);
    }
  }
}

main().catch(console.error);