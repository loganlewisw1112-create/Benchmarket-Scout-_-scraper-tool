import { describe, expect, it } from "vitest";
import {
  buildMarketSummary,
  computeCategoryComparisons,
  computeFinalScore,
  rankCompetitors,
} from "./scoring";
import type { CompetitorReport } from "./types";

function report(id: string, finalScore: number | null): CompetitorReport {
  const available = finalScore !== null;
  return {
    id,
    name: id,
    source: id === "user" ? "user" : "overpass",
    sourceIds: ["S1"],
    auditStatus: available ? "complete" : "unavailable",
    categoryMatchScore: available ? 80 : null,
    localPresenceScore: available ? 70 : null,
    websiteAudit: {
      auditStatus: available ? "complete" : "unavailable",
      skipped: !available,
      sourceIds: available ? ["S1"] : [],
      h1Count: available ? 1 : null,
      headingCount: available ? 3 : null,
      wordCount: available ? 300 : null,
      ctaCount: available ? 1 : null,
      hasPhone: available,
      hasEmail: available,
      hasContactPage: available,
      hasBookingOrQuote: available,
      hasPricingPage: false,
      hasServicesPage: available,
      hasAboutOrTeamPage: available,
      hasBlogOrNewsPage: false,
      hasCareersPage: false,
      hasTestimonials: available,
      hasTrustLanguage: available,
      hasGalleryOrCaseStudy: false,
      hasSocialLinks: false,
      hasViewport: available,
      isHttps: available,
      htmlBytes: available ? 1000 : null,
      fetchMs: available ? 100 : null,
      extractedLinks: [],
      socialLinks: {},
      websiteScore: available ? 50 : null,
      scoreBreakdown: available
        ? { seo: 10, conversion: 15, trust: 10, content: 10, technical: 5 }
        : { seo: null, conversion: null, trust: null, content: null, technical: null },
      evidence: [],
    },
    signals: {
      auditStatus: available ? "complete" : "unavailable",
      newsStatus: "not_requested",
      sourceIds: available ? ["S1"] : [],
      socialLinks: {},
      momentumSignals: [],
      riskSignals: [],
      changeSignals: [],
      offerSignals: [],
      hiringSignals: [],
      newsSignals: [],
      momentumScore: available ? 0 : null,
      riskScore: available ? 0 : null,
      changeScore: available ? 0 : null,
    },
    finalScore,
    rank: null,
  };
}

describe("observed-data scoring", () => {
  it("returns null when any required score is unavailable", () => {
    expect(
      computeFinalScore({
        websiteScore: null,
        localPresenceScore: 50,
        momentumScore: 0,
        riskScore: 0,
      })
    ).toBeNull();
  });

  it("excludes unavailable audits from comparisons", () => {
    const comparisons = computeCategoryComparisons(report("user", 50), [
      report("scored", 70),
      report("unavailable", null),
    ]);
    expect(comparisons).toHaveLength(5);
    expect(comparisons.every((item) => item.totalCompetitors === 1)).toBe(true);
  });

  it("ranks only successfully audited records", () => {
    const user = report("user", 50);
    const scored = report("scored", 70);
    const unavailable = report("unavailable", null);
    const ranked = rankCompetitors(user, [unavailable, scored]);
    expect(ranked.user.rank).toBe(2);
    expect(ranked.competitors.map((item) => [item.id, item.rank])).toEqual([
      ["scored", 1],
      ["unavailable", null],
    ]);
  });

  it("keeps unavailable summary metrics null rather than synthetic zeroes", () => {
    const summary = buildMarketSummary(report("user", null), [
      report("unavailable", null),
    ]);
    expect(summary).toMatchObject({
      competitorCount: 1,
      auditedCompetitorCount: 0,
      competitorAverageWebsiteScore: null,
      competitorAverageFinalScore: null,
      yourRank: null,
      marketGap: null,
      status: null,
    });
  });
});
