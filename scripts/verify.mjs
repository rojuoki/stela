import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const verifyDistDirectory = ".next-verify";
const steps = [
  ["TypeScript", npm, ["run", "typecheck"]],
  ["ESLint", npm, ["run", "lint"]],
  ["coverage frontier", process.execPath, ["--import", "tsx", "scripts/test-io-coverage-frontier.ts"]],
  ["prefix planning", process.execPath, ["--import", "tsx", "scripts/test-io-prefix-planning.ts"]],
  ["prefix settlement", process.execPath, ["--import", "tsx", "scripts/test-io-prefix-settlement.ts"]],
  ["prefix island handling", process.execPath, ["--import", "tsx", "scripts/test-io-prefix-island-import.ts"]],
  ["range planning", process.execPath, ["--import", "tsx", "scripts/test-io-range-planning.ts"]],
  ["IO route authorization", process.execPath, ["--import", "tsx", "scripts/test-io-ui-routes.ts"]],
  ["IO request rate limits", process.execPath, ["--import", "tsx", "scripts/test-io-rate-limit.ts"]],
  ["worker coordinator", process.execPath, ["--import", "tsx", "scripts/test-io-worker-coordinator.ts"]],
  ["production build", npm, ["run", "build"]],
];

try {
  for (const [label, command, args] of steps) {
    console.log(`\n[verify] ${label}`);
    const env = label === "production build"
      ? { ...process.env, STELA_NEXT_DIST_DIR: verifyDistDirectory }
      : process.env;
    const result = spawnSync(command, args, { cwd: process.cwd(), env, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      console.error(`[verify] Failed: ${label}`);
      process.exit(result.status ?? 1);
    }
  }
} finally {
  rmSync(verifyDistDirectory, { recursive: true, force: true });
}

console.log("\n[verify] All offline checks passed");
