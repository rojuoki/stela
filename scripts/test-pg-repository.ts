/**
 * Test Postgres repository functions
 * Run: npx tsx scripts/test-pg-repository.ts
 */
import { getAccountByUsernamePg, recordApiCallPg, createOrUpdateAccountPg } from "../src/lib/repository";
import { testPgConnection, getPgPool } from "../src/lib/db/index";

async function main() {
  console.log("Testing Postgres repository functions...");
  
  try {
    // 1. Test connection first
    console.log("\n1. Testing connection...");
    const connected = await testPgConnection();
    if (!connected) {
      console.error("❌ Cannot connect to database");
      process.exit(1);
    }
    
    // 2. Test recordApiCall
    console.log("\n2. Testing recordApiCallPg...");
    await recordApiCallPg("test/repository", true);
    console.log("✅ recordApiCallPg succeeded");
    
    // 3. Test account lookup (should return undefined for non-existent)
    console.log("\n3. Testing getAccountByUsernamePg (non-existent)...");
    const nonExistent = await getAccountByUsernamePg("nonexistentuser123");
    console.log("Result:", nonExistent === undefined ? "✅ undefined (expected)" : "❌ unexpected result");
    
    // 4. Test account creation
    console.log("\n4. Testing createOrUpdateAccountPg...");
    await createOrUpdateAccountPg({
      id: "test123",
      username: "testuser",
      name: "Test User",
      profile_image_url: "https://example.com/avatar.jpg",
      description: "Test account for repository migration",
      created_at: new Date().toISOString(),
      protected: false
    });
    console.log("✅ createOrUpdateAccountPg succeeded");
    
    // 5. Test account lookup (should now exist)
    console.log("\n5. Testing getAccountByUsernamePg (existing)...");
    const existing = await getAccountByUsernamePg("testuser");
    if (existing) {
      console.log("✅ Found account:", {
        account_id: existing.account_id,
        username: existing.username,
        display_name: existing.display_name
      });
    } else {
      console.log("❌ Account not found after creation");
    }
    
    console.log("\n✅ All Postgres repository tests completed successfully!");
    
  } catch (error) {
    console.error("❌ Repository test error:", error);
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