import { describe, expect, it } from "vitest";
import {
  biggestOpportunityCategory,
  buildMarketSummary,
  classifyAuditOutcome,
  computeCategoryComparisons,
  computeCategoryMatch,
  computeFinalScore,
  computeLocalPresenceScore,
  computeMomentumScore,
  countAuditOutcomes,
  displayStatusForSummary,
  rankCompetitors,
  statusForPosition,
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

describe("local presence", () => {
  it("scores the user and competitors with one formula, normalizing N/A inputs", () => {
    // The user's directory inputs are unobservable (N/A), so it is scored on
    // website + contact alone and is not capped below a fully listed rival.
    const user = computeLocalPresenceScore({
      hasWebsite: true,
      hasPhoneOrEmail: true,
      hasAddressOrCoords: null,
      categoryMatch: null,
      osmCompleteness: null,
    });
    const rival = computeLocalPresenceScore({
      hasWebsite: true,
      hasPhoneOrEmail: true,
      hasAddressOrCoords: true,
      categoryMatch: true,
      osmCompleteness: 1,
    });
    expect(user).toBe(100);
    expect(rival).toBe(100);
  });

  it("treats an observed absence as zero but an unobserved input as N/A", () => {
    const observedMissing = computeLocalPresenceScore({
      hasWebsite: true,
      hasPhoneOrEmail: false,
      hasAddressOrCoords: null,
      categoryMatch: null,
      osmCompleteness: null,
    });
    expect(observedMissing).toBe(60);
    expect(
      computeLocalPresenceScore({
        hasWebsite: null,
        hasPhoneOrEmail: null,
        hasAddressOrCoords: null,
        categoryMatch: null,
        osmCompleteness: null,
      })
    ).toBeNull();
  });

  it("keeps the original points when every input is observed", () => {
    expect(
      computeLocalPresenceScore({
        hasWebsite: true,
        hasPhoneOrEmail: false,
        hasAddressOrCoords: true,
        categoryMatch: true,
        osmCompleteness: 0.75,
      })
    ).toBe(78);
  });

  it("derives category match from real tags, not a constant", () => {
    const tags: Array<[string, string]> = [["leisure", "fitness_centre"]];
    expect(computeCategoryMatch(undefined, tags, "yoga studio")).toBeNull();
    expect(
      computeCategoryMatch(
        { leisure: "fitness_centre", name: "Crunch Fitness" },
        tags,
        "yoga studio"
      )
    ).toBe(0.5);
    expect(
      computeCategoryMatch(
        { leisure: "fitness_centre", sport: "yoga;pilates", name: "Namaste" },
        tags,
        "yoga studio"
      )
    ).toBe(1);
    expect(computeCategoryMatch({ shop: "bakery" }, tags, "yoga studio")).toBe(0);
  });
});

describe("momentum", () => {
  function signals(newsStatus: "complete" | "unavailable" | "not_requested") {
    return {
      ...report("x", 50).signals,
      newsStatus,
      socialLinks: { facebook: "https://facebook.com/x" },
    };
  }

  it("scores unavailable news as N/A (excluded from the max), not as zero", () => {
    // 4 social points out of 75 available when news was not observed, vs.
    // out of 100 when a news search ran and found no articles.
    expect(computeMomentumScore(signals("unavailable"))).toBe(5);
    expect(computeMomentumScore(signals("not_requested"))).toBe(5);
    expect(computeMomentumScore(signals("complete"))).toBe(4);
  });

  it("treats observed news as N/A when the report does not count news", () => {
    expect(computeMomentumScore(signals("complete"), { countNews: false })).toBe(
      computeMomentumScore(signals("not_requested"))
    );
  });
});

describe("ranking and position", () => {
  it("shares a rank on equal scores and never breaks a tie against the user", () => {
    const user = report("user", 68);
    const tiedRival = report("osm-node-1", 68);
    const leader = report("osm-node-2", 80);
    const ranked = rankCompetitors(user, [tiedRival, leader]);
    expect(ranked.user.rank).toBe(2);
    expect(ranked.user.rankTied).toBe(true);
    expect(tiedRival.rank).toBe(2);
    expect(tiedRival.rankTied).toBe(true);
    expect(leader.rank).toBe(1);
    expect(leader.rankTied).toBeUndefined();
    expect(buildMarketSummary(ranked.user, ranked.competitors)).toMatchObject({
      yourRank: 2,
      yourRankTied: true,
      scoringVersion: 2,
    });
  });

  it("excludes corporate chain locations from ranking and leaves them unscored", () => {
    const user = report("user", 60);
    const chain = { ...report("osm-node-9", 90), isChain: true, brand: "Starbucks" };
    const rival = report("osm-node-3", 70);
    const ranked = rankCompetitors(user, [chain, rival]);
    expect(chain.finalScore).toBeNull();
    expect(chain.rank).toBeNull();
    expect(chain.unscoredReason).toBe("corporate chain website");
    expect(ranked.competitors.map((item) => item.id)).toEqual([
      "osm-node-3",
      "osm-node-9",
    ]);
    expect(ranked.user.rank).toBe(2);
    expect(
      buildMarketSummary(ranked.user, ranked.competitors).auditedCompetitorCount
    ).toBe(1);
  });

  it("does not rank a lone scored business or give it a market status", () => {
    const ranked = rankCompetitors(report("user", 72), [report("rival", null)]);
    expect(ranked.user.rank).toBeNull();
    expect(buildMarketSummary(ranked.user, ranked.competitors)).toMatchObject({
      yourRank: null,
      status: null,
      marketGap: null,
    });
  });

  it("derives status from rank and gap so it cannot contradict them", () => {
    const ranked = rankCompetitors(report("user", 60), [
      report("a", 90),
      report("b", 70),
    ]);
    // Last place, 20 points under the average: never "competitive".
    expect(buildMarketSummary(ranked.user, ranked.competitors)).toMatchObject({
      yourRank: 3,
      marketGap: -20,
      status: "low visibility",
    });
    expect(statusForPosition({ rank: 1, gap: 5 })).toBe("leading");
    expect(statusForPosition({ rank: 2, gap: 0.2 })).toBe("competitive");
    expect(statusForPosition({ rank: 4, gap: -14 })).toBe("behind but recoverable");
    expect(statusForPosition({ rank: null, gap: 3 })).toBeNull();
  });

  it("re-derives the displayed status for reports stored before scoring v2", () => {
    const legacy = buildMarketSummary(report("user", 70), []);
    delete legacy.scoringVersion;
    // A v1 report stored "competitive" (score band) for a user ranked last.
    expect(
      displayStatusForSummary({
        ...legacy,
        yourRank: 4,
        marketGap: -17,
        status: "competitive",
      })
    ).toBe("low visibility");
    expect(
      displayStatusForSummary({ ...legacy, scoringVersion: 2, status: "leading" })
    ).toBe("leading");
  });

  it("does not report a small negative gap as +0 or as at-or-above average", () => {
    const ranked = rankCompetitors(report("user", 70), [
      report("a", 71),
      report("b", 70),
    ]);
    const summary = buildMarketSummary(ranked.user, ranked.competitors);
    expect(Object.is(summary.marketGap, -0)).toBe(false);
    expect(summary.marketGap).toBe(0);
    expect(summary.status).toBe("behind but recoverable");
  });

  it("picks the weakest normalized category and skips categories at maximum", () => {
    const user = report("user", 50);
    user.websiteAudit.scoreBreakdown = {
      seo: 15,
      conversion: 25,
      trust: 11,
      content: 16,
      technical: 10,
    };
    // trust 11/20 (55%) is weakest; technical 10/10 is the lowest raw number
    // but already at maximum.
    expect(biggestOpportunityCategory(user)).toBe("trust");
    user.websiteAudit.scoreBreakdown = {
      seo: 25,
      conversion: 25,
      trust: 20,
      content: 20,
      technical: 10,
    };
    expect(biggestOpportunityCategory(user)).toBeUndefined();
  });
});

describe("audit outcomes", () => {
  it("separates no website, failed audits, and audits never attempted", () => {
    const noWebsite = report("osm-a", null);
    const failed = { ...report("osm-b", null), website: "https://b.example" };
    failed.websiteAudit = {
      ...failed.websiteAudit,
      sourceIds: ["S4"],
      reason: "HTTP 403",
    };
    const skipped = { ...report("osm-c", null), website: "https://c.example" };
    skipped.websiteAudit = {
      ...skipped.websiteAudit,
      sourceIds: [],
      reason: "website audit not selected within bounded report capacity",
    };
    const thin = { ...report("osm-d", null), website: "https://d.example" };
    thin.websiteAudit = {
      ...thin.websiteAudit,
      sourceIds: ["S5"],
      reason: "insufficient_content",
    };

    expect(classifyAuditOutcome(noWebsite)).toEqual({
      kind: "no_website",
      reason: "no website listed",
    });
    expect(classifyAuditOutcome(failed)).toEqual({
      kind: "audit_failed",
      reason: "website audit failed: HTTP 403",
    });
    expect(classifyAuditOutcome(skipped).kind).toBe("not_attempted");
    const dead = { ...failed, websiteAudit: { ...failed.websiteAudit, reason: "Domain does not resolve" } };
    expect(classifyAuditOutcome(dead).reason).toBe(
      "website audit failed: domain does not resolve"
    );
    expect(classifyAuditOutcome(thin).reason).toBe(
      "website audit failed: the homepage had too little readable content"
    );
    expect(
      countAuditOutcomes([noWebsite, failed, skipped, thin, report("ok", 60)])
    ).toEqual({
      scored: 1,
      noWebsite: 1,
      auditFailed: 2,
      notAttempted: 1,
      excludedChains: 0,
    });
  });
});
