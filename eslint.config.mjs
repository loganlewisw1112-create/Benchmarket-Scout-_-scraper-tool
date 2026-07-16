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
    // Generated coverage report (npm run test:coverage).
    "coverage/**",
    // Local AI-tooling state, including full repo copies under
    // .claude/worktrees/ — linting those repeats the whole lint N times.
    ".claude/**",
  ]),
]);

export default eslintConfig;
