import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const productionRoots = ["app", "components", "lib", "data"];
const forbiddenPaths = [
  "lib/mock-data.ts",
  "data/demo",
];
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".json"]);
const violations = [];

for (const relativePath of forbiddenPaths) {
  try {
    await stat(path.join(root, relativePath));
    violations.push(`${relativePath}: forbidden legacy demo asset exists`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function walk(relativeDirectory) {
  const absoluteDirectory = path.join(root, relativeDirectory);
  let entries;

  try {
    entries = await readdir(absoluteDirectory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }

  for (const entry of entries) {
    const relativePath = path.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) {
      await walk(relativePath);
      continue;
    }
    if (!sourceExtensions.has(path.extname(entry.name))) continue;
    if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) continue;

    const source = await readFile(path.join(root, relativePath), "utf8");
    const normalizedPath = relativePath.replaceAll("\\", "/");
    // The invariant module must name removed keys so it can reject forged or
    // corrupt payloads at runtime. No other production module may contain them.
    const checks = [
      [/\bdemoMode\b/, "legacy demoMode option", ["lib/invariants.ts"]],
      [/\busedMockData\b/, "legacy mock-data quality flag", ["lib/invariants.ts"]],
      [/\bDEMO_MODE\b/, "legacy DEMO_MODE environment switch", []],
      [/from\s+["'][^"']*mock-data["']|import\s*\([^)]*mock-data[^)]*\)/, "mock-data module import", []],
      [/\bsource(?:Type)?\s*:\s*["']mock["']/, "mock source variant", []],
      [/\bcontainsSyntheticData\s*:\s*true\b/, "synthetic provenance flag", []],
    ];

    for (const [pattern, label, enforcementPaths] of checks) {
      if (pattern.test(source) && !enforcementPaths.includes(normalizedPath)) {
        violations.push(`${normalizedPath}: ${label}`);
      }
    }
  }
}

for (const productionRoot of productionRoots) await walk(productionRoot);

if (violations.length > 0) {
  console.error("Real-data-only production check failed:\n");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log("Real-data-only production check passed.");
