/**
 * Test /api/account endpoint using Postgres
 * Run: npx tsx scripts/test-api-account.ts
 */

async function main() {
  console.log("Testing /api/account endpoint with Postgres...");
  
  if (!process.env.DATABASE_URL) {
    console.error("❌ DATABASE_URL not set. Add your Neon connection string to .env");
    console.log("Example: DATABASE_URL=postgresql://user:password@host/database");
    process.exit(1);
  }
  
  try {
    // Test the endpoint with a known username
    const testUsername = "jack"; // Twitter CEO, should exist
    const url = `http://localhost:3000/api/account?username=${testUsername}`;
    
    console.log(`\nTesting: GET ${url}`);
    console.log("Note: This requires the Next.js dev server to be running on port 3000");
    console.log("Run: npm run dev\n");
    
    const response = await fetch(url);
    const data = await response.json();
    
    if (response.ok) {
      console.log("✅ /api/account endpoint successful!");
      console.log("Response:", {
        account_id: data.account_id,
        username: data.username,
        display_name: data.display_name,
        source: data.source,
        protected: data.protected
      });
      
      if (data.source === "cache") {
        console.log("📦 Data served from Postgres cache");
      } else {
        console.log("🌐 Data fetched from X API and stored in Postgres");
      }
      
    } else {
      console.error("❌ /api/account endpoint failed:");
      console.error("Status:", response.status);
      console.error("Error:", data);
    }
    
  } catch (error) {
    console.error("❌ Test failed:", error);
    if (error instanceof Error && error.message.includes('ECONNREFUSED')) {
      console.log("\nHint: Make sure the Next.js dev server is running:");
      console.log("npm run dev");
    }
  }
}

main().catch(console.error);