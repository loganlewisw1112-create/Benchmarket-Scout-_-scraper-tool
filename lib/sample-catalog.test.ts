import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SAMPLE_CATALOG, SAMPLE_INDUSTRIES } from "./sample-catalog";

describe("real sample catalog", () => {
  it("contains exactly one official HTTPS entry for every planned industry", () => {
    expect(SAMPLE_CATALOG).toHaveLength(25);
    expect(new Set(SAMPLE_CATALOG.map((entry) => entry.id)).size).toBe(25);
    expect(SAMPLE_CATALOG.map((entry) => entry.industry)).toEqual(SAMPLE_INDUSTRIES);
    for (const entry of SAMPLE_CATALOG) {
      expect(new URL(entry.businessUrl).protocol).toBe("https:");
      expect(entry.market).toMatch(/, CA$/);
    }
  });

  it("benchmarks a business in the city its own domain names", () => {
    // Addresses checked on the businesses' own sites on 2026-09-24. These two
    // could not be confirmed (no address found / 403), so their market was
    // left unchanged rather than guessed.
    const unverified = new Set(["roofing-bay-roofing", "florist-central-florist"]);
    const cities = ["hayward", "alameda", "oakland", "berkeley"];
    for (const entry of SAMPLE_CATALOG) {
      if (unverified.has(entry.id)) continue;
      const host = new URL(entry.businessUrl).hostname;
      const named = cities.filter((city) => host.includes(city));
      if (named.length !== 1) continue;
      expect(`${entry.id}: ${entry.market}`).toBe(
        `${entry.id}: ${named[0]![0]!.toUpperCase()}${named[0]!.slice(1)}, CA`
      );
    }
    expect(SAMPLE_CATALOG.find((entry) => entry.id === "hvac-absolute-air-solutions")?.market).toBe(
      "Hayward, CA"
    );
  });

  it("matches the id list the daily refresh workflow iterates", () => {
    const workflow = fs.readFileSync(
      path.join(process.cwd(), ".github", "workflows", "refresh-samples.yml"),
      "utf8"
    );
    const match = /all_catalog=\(([\s\S]*?)\)/.exec(workflow);
    expect(match).not.toBeNull();
    const workflowIds = match![1]!.split(/\s+/).filter(Boolean);
    expect(workflowIds).toEqual(SAMPLE_CATALOG.map((entry) => entry.id));
  });
});
