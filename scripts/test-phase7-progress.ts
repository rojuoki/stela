/**
 * Test Phase 7 progress - auth + partial unlock planning
 * Run: npx tsx scripts/test-phase7-progress.ts
 */

async function testRoute(
  method: string,
  url: string,
  body: any = null,
  description: string
): Promise<{ success: boolean; response?: any; error?: string }> {
  try {
    console.log(`\n${description}`);
    console.log(`Testing: ${method} ${url}`);
    
    const options: RequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
      },
    };
    
    if (body) {
      options.body = JSON.stringify(body);
    }
    
    const response = await fetch(url, options);
    const data = await response.json();
    
    if (response.ok) {
      console.log("✅ Success!");
      console.log("Response:", JSON.stringify(data, null, 2));
      return { success: true, response: data };
    } else {
      console.error("❌ Failed:");
      console.error("Status:", response.status);
      console.error("Error:", data);
      return { success: false, error: `${response.status}: ${JSON.stringify(data)}` };
    }
  } catch (error) {
    console.error("❌ Request failed:", error);
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    if (errorMsg.includes('ECONNREFUSED')) {
      console.log("Hint: Make sure the Next.js dev server is running (npm run dev)");
    }
    return { success: false, error: errorMsg };
  }
}

async function main() {
  console.log("Testing Phase 7 progress with Postgres...");
  
  if (!process.env.DATABASE_URL) {
    console.error("❌ DATABASE_URL not set. Add your Neon connection string to .env");
    process.exit(1);
  }
  
  const baseUrl = "http://localhost:3000";
  
  // Test 1: Auth system (should work from Phase 6)
  const randomEmail = `test7_${Date.now()}@example.com`;
  const authResult = await testRoute(
    "POST",
    `${baseUrl}/api/auth/signup`,
    {
      email: randomEmail,
      password: "testpassword123",
      name: "Phase 7 Test User"
    },
    "1. Auth System (Phase 6 - should work)"
  );
  
  // Test 2: Basic routes (should work from Phase 4-5)
  await testRoute(
    "GET",
    `${baseUrl}/api/health`,
    null,
    "2. Health Check (Phase 4 - should work)"
  );
  
  // Test 3: Account lookup (should work from Phase 3)
  await testRoute(
    "GET",
    `${baseUrl}/api/account?username=jack`,
    null,
    "3. Account Lookup (Phase 3 - should work)"
  );
  
  // Test 4: Unlock route (Phase 7 partial - may fail on dependencies)
  await testRoute(
    "POST",
    `${baseUrl}/api/unlock`,
    {
      username: "jack",
      stage: 1
    },
    "4. Unlock Route (Phase 7 - partially migrated, may fail on job creation)"
  );
  
  console.log("\n" + "=".repeat(60));
  console.log("PHASE 7 PROGRESS SUMMARY");
  console.log("=".repeat(60));
  
  console.log("\nExpected Status:");
  console.log("✅ Auth system - fully functional on Postgres");
  console.log("✅ Basic routes (health, account) - fully functional");
  console.log("🔄 Unlock route - partially migrated:");
  console.log("   - Planning functions updated to Postgres");
  console.log("   - Credit system on Postgres");
  console.log("   - Job creation still depends on SQLite (jobs.ts)");
  console.log("   - May fail at createAndRunJob() call");
  
  console.log("\nNext Phase 7 Steps:");
  console.log("1. Migrate jobs.ts job creation functions to async/Postgres");
  console.log("2. Update remaining direct DB calls in jobs.ts");
  console.log("3. Full unlock flow validation");
  
  if (authResult.success) {
    console.log("\n🎉 Phase 6 foundations solid - auth system working!");
  } else {
    console.log("\n⚠️  Phase 6 foundations need attention");
  }
}

main().catch(console.error);