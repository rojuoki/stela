import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    ".claude/**",
    "prototype/**",
    "results/**",
    "logs/**",
    ".local/**",
  ]),
  {
    files: ["src/components/dashboard/**/*.tsx"],
    rules: {
      // X profile/media URLs are discovered at runtime and cannot use a fixed
      // Next Image remote allowlist. These components intentionally render the
      // provider URLs directly.
      "@next/next/no-img-element": "off",
    },
  },
]);

export default eslintConfig;
