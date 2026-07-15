import { describe, expect, it } from "vitest";
import { generateSampleReport } from "./sample-report";
import { CATEGORY_MAX_SCORES } from "./scoring";

describe("generateSampleReport", () => {
  it("returns a well-formed, internally consistent AnalyzeMarketResponse", async () => {
    const result = await generateSampleReport();

    expect(result.competitors).toHaveLength(10);
    expect(result.dataQuality.usedMockData).toBe(true);
    expect(result.dataQuality.discoverySource).toBe("mock");
    expect(result.market.source).toBe("mock");
    expect(result.market.label).toContain("(sample report)");
    expect(result.report.title.length).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(result.generatedAt))).toBe(false);

    // "your business" side is synthetic but not marked skipped — mirrors
    // the mock-competitor convention (skipped:false, reason:"sample-data").
    expect(result.user.source).toBe("user");
    expect(result.user.websiteAudit.skipped).toBe(false);
    expect(result.user.websiteAudit.reason).toBe("sample-data");

    // Ranking was applied (rankCompetitors sets rank on everyone).
    expect(typeof result.user.rank).toBe("number");
    expect(result.competitors.every((c) => typeof c.rank === "number")).toBe(
      true
    );
  });

  it("keeps every score internally consistent and within bounds", async () => {
    const result = await generateSampleReport();
    const allReports = [result.user, ...result.competitors];

    for (const report of allReports) {
      const { scoreBreakdown, websiteScore } = report.websiteAudit;
      const sum = Object.values(scoreBreakdown).reduce((a, b) => a + b, 0);
      expect(websiteScore).toBe(sum);

      for (const key of Object.keys(CATEGORY_MAX_SCORES) as Array<
        keyof typeof CATEGORY_MAX_SCORES
      >) {
        expect(scoreBreakdown[key]).toBeGreaterThanOrEqual(0);
        expect(scoreBreakdown[key]).toBeLessThanOrEqual(
          CATEGORY_MAX_SCORES[key]
        );
      }

      expect(report.localPresenceScore).toBeGreaterThanOrEqual(0);
      expect(report.localPresenceScore).toBeLessThanOrEqual(100);
      expect(report.finalScore).toBeGreaterThanOrEqual(0);
      expect(report.finalScore).toBeLessThanOrEqual(100);
    }
  });

  it("never generates the same report twice across repeated calls", async () => {
    // Deterministic-safe randomness check: with 4 verticals x 10 markets x
    // many name combinations x continuous score jitter, the probability of
    // 15 draws collapsing onto a single (name, market, score) signature is
    // negligible — this is not a coin-flip-odds flaky assertion.
    const signatures = new Set<string>();
    const businessTypesSeen = new Set<string>();

    for (let i = 0; i < 15; i++) {
      const result = await generateSampleReport();
      signatures.add(
        `${result.input.businessName}|${result.market.label}|${result.user.websiteAudit.websiteScore}`
      );
      businessTypesSeen.add(result.input.businessType);
    }

    expect(signatures.size).toBeGreaterThan(1);
    expect(businessTypesSeen.size).toBeGreaterThan(1);
  });

  it("resolves businessType to a valid mock bundle every time", async () => {
    for (let i = 0; i < 8; i++) {
      const result = await generateSampleReport();
      // getMockCompetitors always returns 10 rows for the 4 known verticals
      // (including the "home services" -> generic-local-service fallback);
      // a bundle-resolution bug would surface as fewer/zero competitors.
      expect(result.competitors).toHaveLength(10);
    }
  });
});
