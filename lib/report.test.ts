import { describe, expect, it } from "vitest";
import { generateBenchmarkReport } from "./report";
import { buildMarketSummary, rankCompetitors } from "./scoring";
import type { CompetitorReport, DataQuality, MarketSignal, Recommendation } from "./types";

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
    expect(output.executiveSummary).toContain("near Austin, TX");
    expect(output.executiveSummary).not.toMatch(/\(s\)|\(es\)/);
    expect(output.positionStatement).toContain("not ranked");
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

  it("never repeats the same risk label and evidence for one business", () => {
    const user = report("user", 50);
    const risk: MarketSignal = {
      label: "Risk language",
      evidence: "Temporarily closed",
      sourceUrl: "https://acme.test",
      sourceType: "homepage",
      sourceIds: ["S4"],
      confidence: "medium",
    };
    user.signals.riskSignals.push(risk, { ...risk, sourceUrl: "https://acme.test/about" });
    const output = generateBenchmarkReport({
      input: {
        businessName: "Acme",
        businessUrl: "https://acme.test",
        businessType: "plumber",
        market: "Austin, TX",
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
    expect(output.topRisks).toHaveLength(1);
  });

  it("names the resolved market and the search radius, not the typed string", () => {
    const output = generateBenchmarkReport({
      input: {
        businessName: "Acme",
        businessUrl: "https://acme.test",
        businessType: "plumber",
        market: "Austin, TX",
      },
      user: report("user", 50),
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
      market: { label: "Austin, Travis County, Texas, United States", radiusKm: 5.1 },
    });
    expect(output.executiveSummary).toContain(
      "within 5.1 km of Austin, Travis County, Texas, United States"
    );
    expect(output.topFindings[0].finding).toContain(
      "near Austin, Travis County, Texas, United States"
    );
  });
});

describe("report prose (scoring v2)", () => {
  const input = {
    businessName: "Acme",
    businessUrl: "https://acme.test",
    businessType: "plumber",
    market: "Austin, TX",
  };

  function scored(id: string, score: number, distanceKm?: number): CompetitorReport {
    const record = report(id, score);
    record.rank = null;
    if (distanceKm !== undefined) record.distanceKm = distanceKm;
    return record;
  }

  function unscored(
    id: string,
    overrides: Partial<CompetitorReport> = {},
    audit: Partial<CompetitorReport["websiteAudit"]> = {}
  ): CompetitorReport {
    const record = report(id, null);
    Object.assign(record.websiteAudit, audit);
    return Object.assign(record, overrides);
  }

  function build(user: CompetitorReport, competitors: CompetitorReport[], recommendations: Recommendation[] = []) {
    const ranked = rankCompetitors(user, competitors);
    const summary = buildMarketSummary(ranked.user, ranked.competitors);
    return generateBenchmarkReport({
      input,
      user: ranked.user,
      competitors: ranked.competitors,
      summary,
      recommendations,
      dataQuality: {
        ...dataQuality,
        realCompetitorsFound: competitors.length,
      },
      discoverySourceIds: ["S3"],
    });
  }

  it("says 'near' the market with a distance range and discloses a shared rank", () => {
    const output = build(scored("user", 70), [
      scored("rival", 70, 1.2),
      scored("other", 60, 8.44),
    ]);
    expect(output.positionStatement).toContain(
      "Acme is tied for #1 of 3 scored businesses near Austin, TX"
    );
    expect(output.positionStatement).toContain("1.2–8.4 km from the market center");
    expect(output.executiveSummary).not.toMatch(/ in Austin, TX/);
    expect(output.topFindings[0]).toMatchObject({
      title: "Observed market position",
      finding: "Tied for #1 of 3 scored businesses near Austin, TX.",
    });
    expect(output.topFindings.length).toBeLessThanOrEqual(3);
  });

  it("keeps comparative confidence low with few scored competitors", () => {
    const output = build(scored("user", 70), [scored("rival", 60)]);
    expect(output.topFindings[0].confidence).toBe("low");
  });

  it("separates no website, failed and not-attempted audits in readable prose", () => {
    const output = build(scored("user", 70), [
      scored("rival", 60),
      unscored("no-site"),
      unscored(
        "dead-site",
        { website: "https://dead.test" },
        { reason: "dns_unresolved", sourceIds: ["S3"] }
      ),
      unscored(
        "skipped",
        { website: "https://skipped.test" },
        { reason: "website audit not selected within bounded report capacity" }
      ),
    ]);
    expect(output.dataQualityNote).toContain("1 had no website listed");
    expect(output.dataQualityNote).toContain("1 website audit failed");
    expect(output.dataQualityNote).toContain(
      "1 was not audited because of the report's audit limit"
    );
    expect(output.dataQualityNote).not.toMatch(/\(s\)|osm-node|websiteAudit/);
  });

  it("always states why an action plan is empty", () => {
    const noGaps = build(scored("user", 70), [scored("rival", 60)]);
    expect(noGaps.actionPlan).toEqual([]);
    expect(noGaps.actionPlanNote).toMatch(/^No material gaps found/);

    const noBenchmark = build(scored("user", 70), [unscored("no-site")]);
    expect(noBenchmark.actionPlanNote).toMatch(/no nearby competitor could be scored/);

    const withPlan = build(scored("user", 70), [scored("rival", 60)], [
      {
        title: "Add a meta description",
        why: "Missing.",
        action: "Write one.",
        evidence: "Missing.",
        sourceIds: ["S1"],
        priority: "low",
      },
    ]);
    expect(withPlan.actionPlanNote).toBeUndefined();
  });
});
