import { describe, expect, it } from "vitest";
import { generateRecommendations } from "./recommendations";
import type { CompetitorReport, NullableScoreBreakdown } from "./types";

function report(
  id: string,
  breakdown: NullableScoreBreakdown | null
): CompetitorReport {
  const available = breakdown !== null;
  return {
    id,
    name: id,
    source: id === "user" ? "user" : "overpass",
    sourceIds: [id === "user" ? "S1" : "S2"],
    auditStatus: available ? "complete" : "unavailable",
    categoryMatchScore: available ? 100 : null,
    localPresenceScore: available ? 80 : null,
    websiteAudit: {
      auditStatus: available ? "complete" : "unavailable",
      skipped: !available,
      sourceIds: available ? ["S1"] : [],
      h1Count: null,
      headingCount: null,
      wordCount: null,
      ctaCount: null,
      hasPhone: null,
      hasEmail: null,
      hasContactPage: null,
      hasBookingOrQuote: null,
      hasPricingPage: null,
      hasServicesPage: null,
      hasAboutOrTeamPage: null,
      hasBlogOrNewsPage: null,
      hasCareersPage: null,
      hasTestimonials: null,
      hasTrustLanguage: null,
      hasGalleryOrCaseStudy: null,
      hasSocialLinks: null,
      hasViewport: null,
      isHttps: null,
      htmlBytes: null,
      fetchMs: null,
      extractedLinks: [],
      socialLinks: {},
      websiteScore: breakdown
        ? Object.values(breakdown).reduce<number>(
            (sum, value) => sum + (value ?? 0),
            0
          )
        : null,
      scoreBreakdown:
        breakdown ?? {
          seo: null,
          conversion: null,
          trust: null,
          content: null,
          technical: null,
        },
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
    finalScore: available ? 50 : null,
    rank: null,
  };
}

describe("generateRecommendations", () => {
  it("returns no generic recommendations without comparative evidence", () => {
    const user = report("user", {
      seo: 10,
      conversion: 10,
      trust: 10,
      content: 10,
      technical: 5,
    });
    expect(generateRecommendations({ user, competitors: [] })).toEqual([]);
    expect(
      generateRecommendations({ user: report("user", null), competitors: [user] })
    ).toEqual([]);
  });

  it("returns only observed gap recommendations with source IDs", () => {
    const user = report("user", {
      seo: 5,
      conversion: 14,
      trust: 15,
      content: 15,
      technical: 9,
    });
    const rival = report("rival", {
      seo: 20,
      conversion: 20,
      trust: 15,
      content: 15,
      technical: 9,
    });
    const recommendations = generateRecommendations({
      user,
      competitors: [rival],
    });
    expect(recommendations.map((item) => item.title)).toEqual([
      "Close the on-page SEO gap",
      "Close the conversion elements gap",
    ]);
    expect(recommendations[0]).toMatchObject({
      priority: "high",
      sourceIds: ["S1", "S2"],
    });
    expect(recommendations[0].evidence).toContain("across 1 successful audits");
  });
});
