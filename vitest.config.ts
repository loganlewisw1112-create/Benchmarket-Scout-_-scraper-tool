import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": projectRoot,
    },
  },
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts"],
    coverage: {
      // Report-only: no thresholds enforced (visibility, not a gate).
      provider: "v8",
      include: ["lib/**/*.ts", "app/**/*.ts", "app/**/*.tsx", "components/**/*.tsx"],
      exclude: ["lib/**/*.test.ts", "lib/test-fixtures.ts", "lib/types.ts"],
      reporter: ["text", "html"],
    },
  },
});
