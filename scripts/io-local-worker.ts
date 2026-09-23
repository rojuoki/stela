import { loadEnvConfig } from "@next/env";

// Match Next's local environment precedence without printing credentials.
loadEnvConfig(process.cwd(), true);
void import("./io-pg-worker").catch(() => {
  console.error("IO worker could not start. Check the worker configuration and logs.");
  process.exitCode = 1;
});
