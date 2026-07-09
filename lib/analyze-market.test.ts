import { beforeAll, describe, expect, it } from "vitest";
import { analyzeMarket } from "./analyze-market";

// End-to-end pipeline test that runs fully offline:
// - demoMode "mock" skips geocoding/Overpass/GDELT entirely and loads
//   competitors from data/demo/dentist.json.
// - The user URL https://127.0.0.1 is deterministically rejected by the
//   SSRF guard before any network request, producing a skipped audit.
describe("analyzeMarket (offline, mock mode)", () => {
  beforeAll(() => {
    // Keep test cache writes inside the gitignored .cache tree, isolated
    // from the app's real cache buckets.
    process.env.CACHE_DIR = ".cache/test";
  });

  it("produces a complete, well-formed response without network access", async () => {
    const response = await analyzeMarket({
      businessName: "Test Co",
      businessUrl: "https://127.0.0.1",
      businessType: "dentist",
      market: "Austin, TX",
      options: { demoMode: "mock" },
    });

    // Market comes from mock mode, never a live geocoder.
    expect(response.market.source).toBe("mock");

    // Competitors come from the labeled demo bundle.
    expect(response.competitors.length).toBeGreaterThan(0);
    expect(response.competitors.length).toBeLessThanOrEqual(10);
    expect(response.competitors.every((c) => c.source === "mock")).toBe(true);

    // Data quality honestly reports the mock provenance.
    expect(response.dataQuality.usedMockData).toBe(true);
    expect(response.dataQuality.discoverySource).toBe("mock");
    expect(response.dataQuality.liveCompetitorsFound).toBe(0);

    // The user's site audit was blocked by the SSRF guard, not fetched.
    expect(response.user.source).toBe("user");
    expect(response.user.websiteAudit.skipped).toBe(true);

    // Everyone is ranked, and scores are within bounds.
    expect(typeof response.user.rank).toBe("number");
    for (const competitor of response.competitors) {
      expect(typeof competitor.rank).toBe("number");
      expect(competitor.finalScore).toBeGreaterThanOrEqual(0);
      expect(competitor.finalScore).toBeLessThanOrEqual(100);
    }

    // Report and summary are generated and non-empty.
    expect(response.report.title.length).toBeGreaterThan(0);
    expect(response.report.executiveSummary.length).toBeGreaterThan(0);
    expect(Array.isArray(response.report.actionPlan)).toBe(true);
    expect(Array.isArray(response.recommendations)).toBe(true);
    expect(response.summary.competitorCount).toBe(response.competitors.length);

    // Timestamp is a valid ISO date.
    expect(Number.isNaN(Date.parse(response.generatedAt))).toBe(false);
  });
});
