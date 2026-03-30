/**
 * Test Phase 4-5 migrated routes using Postgres
 * Run: npx tsx scripts/test-phase4-routes.ts
 */

async function testRoute(url: string, description: string): Promise<boolean> {
  try {
    console.log(`\n${description}`);
    console.log(`Testing: GET ${url}`);
    
    const response = await fetch(url);
    const data = await response.json();
    
    if (response.ok) {
      console.log("✅ Success!");
      console.log("Response:", JSON.stringify(data, null, 2));
      return true;
    } else {
      console.error("❌ Failed:");
      console.error("Status:", response.status);
      console.error("Error:", data);
      return false;
    }
  } catch (error) {
    console.error("❌ Request failed:", error);
    if (error instanceof Error && error.message.includes('ECONNREFUSED')) {
      console.log("Hint: Make sure the Next.js dev server is running (npm run dev)");
    }
    return false;
  }
}

async function main() {
  console.log("Testing Phase 4 routes with Postgres...");
  
  if (!process.env.DATABASE_URL) {
    console.error("❌ DATABASE_URL not set. Add your Neon connection string to .env");
    console.log("Example: DATABASE_URL=postgresql://user:password@host/database");
    process.exit(1);
  }
  
  const baseUrl = "http://localhost:3000";
  let allPassed = true;
  
  // Test 1: Health check
  allPassed &&= await testRoute(
    `${baseUrl}/api/health`,
    "1. Health Check (Postgres connectivity)"
  );
  
  // Test 2: Account unlock status
  allPassed &&= await testRoute(
    `${baseUrl}/api/account/unlock-status?username=jack`,
    "2. Account Unlock Status (read-only unlock route)"
  );
  
  // Test 3: Auth me endpoint (should work without DB changes)
  allPassed &&= await testRoute(
    `${baseUrl}/api/auth/me`,
    "3. Auth Me (JWT verification, no DB needed)"
  );
  
  // Test 4: Original account endpoint (already migrated in Phase 3)
  allPassed &&= await testRoute(
    `${baseUrl}/api/account?username=jack`,
    "4. Account Lookup (Phase 3 - already migrated)"
  );
  
  // Phase 5 tests: Direct DB bypass routes
  
  // Test 5: Guest unlock session (needs session_id parameter)
  allPassed &&= await testRoute(
    `${baseUrl}/api/guest-unlock/session?session_id=test_session`,
    "5. Guest Unlock Session (Phase 5 - expect 404 for test session)"
  );
  
  // Test 6: Dev jobs panel (dev panel needs to be enabled)
  if (process.env.NEXT_PUBLIC_DEV_PANEL === "1") {
    allPassed &&= await testRoute(
      `${baseUrl}/api/dev/jobs`,
      "6. Dev Jobs Panel (Phase 5 - active jobs list)"
    );
  } else {
    console.log("\n6. Dev Jobs Panel (Phase 5) - SKIPPED (NEXT_PUBLIC_DEV_PANEL not enabled)");
  }
  
  console.log("\n" + "=".repeat(50));
  if (allPassed) {
    console.log("🎉 All Phase 4-5 routes working with Postgres!");
  } else {
    console.log("⚠️  Some routes failed - check logs above");
  }
  
  console.log("\nNote: Auth endpoints may return 401 (not authenticated) - this is expected");
  console.log("Guest unlock session may return 404 (test session not found) - this is expected");
  console.log("Phase 4-5 migration focuses on database connectivity, not business logic validation");
}

main().catch(console.error);