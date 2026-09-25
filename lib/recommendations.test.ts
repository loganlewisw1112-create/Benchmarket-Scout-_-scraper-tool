import { describe, expect, it } from "vitest";
import { generateRecommendations } from "./recommendations";
import type { CompetitorReport, SourceId, WebsiteAudit } from "./types";

function audit(
  homepageSourceId: SourceId,
  overrides: Partial<WebsiteAudit> = {}
): WebsiteAudit {
  return {
    auditStatus: "complete",
    skipped: false,
    sourceIds: [homepageSourceId],
    title: "Homepage",
    metaDescription: "Description",
    h1Count: 1,
    headingCount: 4,
    wordCount: 400,
    ctaCount: 3,
    hasPhone: true,
    hasEmail: false,
    hasContactPage: true,
    hasBookingOrQuote: true,
    hasPricingPage: false,
    hasServicesPage: true,
    hasAboutOrTeamPage: true,
    hasBlogOrNewsPage: true,
    hasCareersPage: false,
    hasTestimonials: true,
    hasTrustLanguage: true,
    hasGalleryOrCaseStudy: true,
    hasSocialLinks: false,
    hasViewport: true,
    isHttps: true,
    htmlBytes: 20_000,
    fetchMs: 300,
    extractedLinks: [],
    socialLinks: {},
    websiteScore: 90,
    scoreBreakdown: { seo: 20, conversion: 25, trust: 20, content: 16, technical: 9 },
    evidence: [
      {
        claim: "Homepage fetched successfully in 300ms.",
        sourceUrl: "https://example.test/",
        sourceType: "homepage",
        sourceIds: [homepageSourceId],
        confidence: "high",
      },
    ],
    ...overrides,
  };
}

function unavailableAudit(): WebsiteAudit {
  return {
    ...audit("S1"),
    auditStatus: "unavailable",
    skipped: true,
    sourceIds: [],
    title: undefined,
    metaDescription: undefined,
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
    websiteScore: null,
    scoreBreakdown: { seo: null, conversion: null, trust: null, content: null, technical: null },
    evidence: [],
  };
}

function entity(
  id: string,
  websiteAudit: WebsiteAudit,
  extra: Partial<CompetitorReport> = {}
): CompetitorReport {
  const available = websiteAudit.auditStatus !== "unavailable";
  return {
    id,
    name: id,
    source: id === "user" ? "user" : "overpass",
    website: `https://${id}.test/`,
    // Record-level IDs include discovery, user-input and news sources that a
    // recommendation must never cite.
    sourceIds: ["S90", "S91", ...websiteAudit.sourceIds],
    auditStatus: websiteAudit.auditStatus,
    categoryMatchScore: null,
    localPresenceScore: available ? 80 : null,
    websiteAudit,
    signals: {
      auditStatus: websiteAudit.auditStatus,
      newsStatus: "unavailable",
      sourceIds: ["S92"],
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
    finalScore: available ? 60 : null,
    rank: null,
    ...extra,
  };
}

describe("generateRecommendations", () => {
  it("returns nothing without a scored user or a scored competitor", () => {
    const user = entity("user", audit("S2", { metaDescription: undefined }));
    expect(generateRecommendations({ user, competitors: [] })).toEqual([]);
    expect(
      generateRecommendations({
        user,
        competitors: [entity("rival", unavailableAudit())],
      })
    ).toEqual([]);
    expect(
      generateRecommendations({
        user: entity("user", unavailableAudit()),
        competitors: [entity("rival", audit("S3"))],
      })
    ).toEqual([]);
  });

  it("recommends only elements the user's audit observed as missing", () => {
    const user = entity(
      "user",
      audit("S2", { metaDescription: undefined, hasTestimonials: false })
    );
    const recommendations = generateRecommendations({
      user,
      competitors: [entity("rival", audit("S3"))],
    });
    expect(recommendations.map((item) => item.title)).toEqual([
      "Show testimonials or client reviews",
      "Add a meta description",
    ]);
    // The user already has a services page, so it is never recommended.
    expect(JSON.stringify(recommendations)).not.toMatch(/services page/i);
  });

  it("cites only the user's and adopting scored competitors' homepage sources", () => {
    const user = entity("user", audit("S2", { hasTestimonials: false }));
    const adopter = entity("adopter", audit("S3"));
    const nonAdopter = entity("non-adopter", audit("S4", { hasTestimonials: false }));
    const failed = entity("failed", unavailableAudit());
    const chain = entity("chain", audit("S5"), { isChain: true, finalScore: null });
    const [recommendation] = generateRecommendations({
      user,
      competitors: [adopter, nonAdopter, failed, chain],
    });
    expect(recommendation.sourceIds).toEqual(["S2", "S3"]);
    expect(recommendation.why).toBe(
      "Your homepage audit did not find testimonials or client reviews. 1 of 2 scored competitors show it (adopter)."
    );
    expect(recommendation.priority).toBe("high");
  });

  it("never presents '0 of N' competitors as support", () => {
    const user = entity("user", audit("S2", { hasTestimonials: false }));
    const rival = entity("rival", audit("S3", { hasTestimonials: false }));
    const [recommendation] = generateRecommendations({ user, competitors: [rival] });
    expect(recommendation.title).toBe("Show testimonials or client reviews");
    expect(recommendation.why).not.toMatch(/\b0 of\b/);
    expect(recommendation.evidence).not.toMatch(/\b0 of\b/);
    expect(recommendation.sourceIds).toEqual(["S2"]);
    expect(recommendation.priority).toBe("low");
  });

  it("merges overlapping services recommendations into one", () => {
    const user = entity(
      "user",
      audit("S2", { hasServicesPage: false, hasPricingPage: false })
    );
    const titles = generateRecommendations({
      user,
      competitors: [entity("rival", audit("S3"))],
    }).map((item) => item.title);
    expect(titles).toEqual(["Add a dedicated services page"]);
  });

  it("returns no recommendations when the user shows every checked element", () => {
    expect(
      generateRecommendations({
        user: entity("user", audit("S2")),
        competitors: [entity("rival", audit("S3"))],
      })
    ).toEqual([]);
  });
});
