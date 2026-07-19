import { describe, expect, it } from "vitest";
import { generateBenchmarkReport } from "./report";
import type { CompetitorReport, DataQuality } from "./types";

function report(id: string, score: number | null): CompetitorReport {
  const available = score !== null;
  return {
    id,
    name: id,
    source: id === "user" ? "user" : "overpass",
    sourceIds: [id === "user" ? "S1" : "S3"],
    auditStatus: available ? "complete" : "unavailable",
    categoryMatchScore: available ? 100 : null,
    localPresenceScore: available ? 80 : null,
    websiteAudit: {
      auditStatus: available ? "complete" : "unavailable",
      skipped: !available,
      reason: available ? undefined : "fetch failed",
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
      websiteScore: available ? 50 : null,
      scoreBreakdown: available
        ? { seo: 10, conversion: 10, trust: 10, content: 10, technical: 10 }
        : { seo: null, conversion: null, trust: null, content: null, technical: null },
      evidence: [],
    },
    signals: {
      auditStatus: available ? "complete" : "unavailable",
      newsStatus: "complete",
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
    finalScore: score,
    rank: available ? 1 : null,
  };
}

const dataQuality: DataQuality = {
  coverageStatus: "partial",
  realCompetitorsFound: 1,
  scoredCompetitors: 0,
  failedAudits: 1,
  limitedAudits: 0,
  unavailableFields: ["competitor.websiteScore"],
  cacheHit: false,
  notes: [],
};

describe("generateBenchmarkReport", () => {
  it("renders N/A-ready coverage without simulation or synthetic claims", () => {
    const output = generateBenchmarkReport({
      input: {
        businessName: "Acme",
        businessUrl: "https://acme.test",
        businessType: "plumber",
        market: "Austin, TX",
      },
      user: report("user", 50),
      competitors: [report("rival", null)],
      summary: {
        competitorCount: 1,
        auditedCompetitorCount: 0,
        competitorAverageWebsiteScore: null,
        competitorAverageFinalScore: null,
        yourRank: 1,
        marketGap: null,
        status: "behind but recoverable",
      },
      recommendations: [],
      dataQuality,
      discoverySourceIds: ["S3"],
    });
    expect(output.executiveSummary).toContain("real competitor");
    expect(output.topFindings[0]).toMatchObject({
      title: "No scored competitor benchmark available",
      sourceIds: ["S3"],
    });
    expect(JSON.stringify(output)).not.toMatch(/projection|modeled rank|fallback/i);
  });

  it("uses signal provenance for risks", () => {
    const user = report("user", 50);
    user.signals.riskSignals.push({
      label: "Risk language",
      evidence: "Reduced hours",
      sourceUrl: "https://acme.test",
      sourceType: "homepage",
      sourceIds: ["S4"],
      confidence: "medium",
    });
    const output = generateBenchmarkReport({
      input: {
        businessName: "Acme",
        businessUrl: "https://acme.test",
        businessType: "plumber",
        market: "Austin",
      },
      user,
      competitors: [],
      summary: {
        competitorCount: 0,
        auditedCompetitorCount: 0,
        competitorAverageWebsiteScore: null,
        competitorAverageFinalScore: null,
        yourRank: 1,
        marketGap: null,
        status: "behind but recoverable",
      },
      recommendations: [],
      dataQuality: { ...dataQuality, realCompetitorsFound: 0 },
      discoverySourceIds: ["S3"],
    });
    expect(output.topRisks[0].sourceIds).toEqual(["S4"]);
  });
});
