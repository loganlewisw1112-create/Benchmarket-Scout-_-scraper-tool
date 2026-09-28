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
    // Every market is the business's own city (OSM addr:city, checked against
    // the business's site where it states an address, 2026-09-28).
    const markets = new Set([
      "Alameda, CA",
      "Oakland, CA",
      "Berkeley, CA",
      "San Francisco, CA",
      "San Jose, CA",
    ]);
    const cities = ["alameda", "oakland", "berkeley"];
    for (const entry of SAMPLE_CATALOG) {
      expect(markets.has(entry.market), `${entry.id}: ${entry.market}`).toBe(true);
      const host = new URL(entry.businessUrl).hostname;
      const named = cities.filter((city) => host.includes(city));
      if (named.length !== 1) continue;
      expect(`${entry.id}: ${entry.market}`).toBe(
        `${entry.id}: ${named[0]![0]!.toUpperCase()}${named[0]!.slice(1)}, CA`
      );
    }
    expect(new Set(SAMPLE_CATALOG.map((entry) => entry.market)).size).toBe(markets.size);
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
