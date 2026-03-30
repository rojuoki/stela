/**
 * Test Phase 6 routes (unlock + auth) using Postgres
 * Run: npx tsx scripts/test-phase6-routes.ts
 */

interface TestResult {
  name: string;
  success: boolean;
  response?: any;
  error?: string;
}

async function testRoute(
  method: string,
  url: string,
  body: any = null,
  description: string
): Promise<TestResult> {
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
      return { name: description, success: true, response: data };
    } else {
      console.error("❌ Failed:");
      console.error("Status:", response.status);
      console.error("Error:", data);
      return { name: description, success: false, error: `${response.status}: ${JSON.stringify(data)}` };
    }
  } catch (error) {
    console.error("❌ Request failed:", error);
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    if (errorMsg.includes('ECONNREFUSED')) {
      console.log("Hint: Make sure the Next.js dev server is running (npm run dev)");
    }
    return { name: description, success: false, error: errorMsg };
  }
}

async function main() {
  console.log("Testing Phase 6 routes (unlock + auth) with Postgres...");
  
  if (!process.env.DATABASE_URL) {
    console.error("❌ DATABASE_URL not set. Add your Neon connection string to .env");
    console.log("Example: DATABASE_URL=postgresql://user:password@host/database");
    process.exit(1);
  }
  
  const baseUrl = "http://localhost:3000";
  const results: TestResult[] = [];
  
  // Test auth signup
  const randomEmail = `test_${Date.now()}@example.com`;
  results.push(await testRoute(
    "POST",
    `${baseUrl}/api/auth/signup`,
    {
      email: randomEmail,
      password: "testpassword123",
      name: "Test User"
    },
    "1. Auth Signup (create new user)"
  ));
  
  // Test auth login
  results.push(await testRoute(
    "POST",
    `${baseUrl}/api/auth/login`,
    {
      email: randomEmail,
      password: "testpassword123"
    },
    "2. Auth Login (authenticate user)"
  ));
  
  // Test auth login with wrong password
  results.push(await testRoute(
    "POST",
    `${baseUrl}/api/auth/login`,
    {
      email: randomEmail,
      password: "wrongpassword"
    },
    "3. Auth Login (wrong password - should fail)"
  ));
  
  // Test unlock endpoint (will likely fail due to missing supporting functions)
  results.push(await testRoute(
    "POST",
    `${baseUrl}/api/unlock`,
    {
      username: "jack",
      stage: 1
    },
    "4. Unlock Route (expect errors due to dependencies)"
  ));
  
  // Summary
  console.log("\n" + "=".repeat(60));
  console.log("PHASE 6 TEST SUMMARY");
  console.log("=".repeat(60));
  
  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);
  
  console.log(`✅ Successful tests: ${successful.length}`);
  successful.forEach(r => console.log(`  - ${r.name}`));
  
  console.log(`❌ Failed tests: ${failed.length}`);
  failed.forEach(r => console.log(`  - ${r.name}: ${r.error}`));
  
  console.log("\nExpected Results:");
  console.log("- Auth signup/login should work (Postgres fully implemented)");
  console.log("- Wrong password should fail with 401");
  console.log("- Unlock may fail due to missing dependent functions (planInitialUnlock, createAndRunJob)");
  console.log("- This is normal - auth functions are fully migrated, unlock needs more work");
  
  const authTests = results.filter(r => r.name.includes('Auth'));
  const authSuccess = authTests.filter(r => r.success).length;
  
  if (authSuccess >= 2) {
    console.log("\n🎉 Auth migration successful! Login/signup working with Postgres.");
  } else {
    console.log("\n⚠️  Auth migration needs attention - check errors above.");
  }
}

main().catch(console.error);