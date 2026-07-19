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
});
