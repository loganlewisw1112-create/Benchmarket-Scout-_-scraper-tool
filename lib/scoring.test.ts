import { describe, expect, it } from "vitest";
import {
  computeChangeScore,
  computeFinalScore,
  computeLocalPresenceScore,
  computeMomentumScore,
  computeRiskScore,
  rankCompetitors,
  statusForScore,
} from "./scoring";
import type {
  CompetitorReport,
  MarketSignal,
  SignalScan,
  WebsiteAudit,
} from "./types";

function makeSignalList(count: number): MarketSignal[] {
  return Array.from({ length: count }, (_, i) => ({
    label: `signal-${i}`,
    evidence: "test evidence",
    sourceType: "mock" as const,
    confidence: "low" as const,
  }));
}

function makeSignals(overrides: Partial<SignalScan> = {}): SignalScan {
  return {
    socialLinks: {},
    momentumSignals: [],
    riskSignals: [],
    changeSignals: [],
    offerSignals: [],
    hiringSignals: [],
    newsSignals: [],
    momentumScore: 0,
    riskScore: 0,
    changeScore: 0,
    ...overrides,
  };
}

function makeAudit(): WebsiteAudit {
  return {
    skipped: true,
    h1Count: 0,
    headingCount: 0,
    wordCount: 0,
    ctaCount: 0,
    hasPhone: false,
    hasEmail: false,
    hasContactPage: false,
    hasBookingOrQuote: false,
    hasPricingPage: false,
    hasServicesPage: false,
    hasAboutOrTeamPage: false,
    hasBlogOrNewsPage: false,
    hasCareersPage: false,
    hasTestimonials: false,
    hasTrustLanguage: false,
    hasGalleryOrCaseStudy: false,
    hasSocialLinks: false,
    hasViewport: false,
    isHttps: false,
    htmlBytes: 0,
    fetchMs: 0,
    extractedLinks: [],
    socialLinks: {},
    websiteScore: 0,
    scoreBreakdown: { seo: 0, conversion: 0, trust: 0, content: 0, technical: 0 },
    evidence: [],
  };
}

function makeReport(args: {
  name: string;
  source: CompetitorReport["source"];
  finalScore: number;
}): CompetitorReport {
  return {
    id: args.name,
    name: args.name,
    source: args.source,
    categoryMatchScore: 0,
    localPresenceScore: 0,
    websiteAudit: makeAudit(),
    signals: makeSignals(),
    finalScore: args.finalScore,
  };
}

describe("computeFinalScore", () => {
  it("weights website 60%, presence 20%, momentum 15%, inverse risk 5%", () => {
    expect(
      computeFinalScore({
        websiteScore: 100,
        localPresenceScore: 100,
        momentumScore: 100,
        riskScore: 0,
      })
    ).toBe(100);

    expect(
      computeFinalScore({
        websiteScore: 50,
        localPresenceScore: 80,
        momentumScore: 20,
        riskScore: 40,
      })
    ).toBe(52); // 30 + 16 + 3 + 3

    expect(
      computeFinalScore({
        websiteScore: 0,
        localPresenceScore: 0,
        momentumScore: 0,
        riskScore: 100,
      })
    ).toBe(0);
  });
});

describe("computeLocalPresenceScore", () => {
  it("caps at 100 with everything present", () => {
    expect(
      computeLocalPresenceScore({
        hasWebsite: true,
        hasPhoneOrEmail: true,
        hasAddressOrCoords: true,
        categoryMatch: true,
        osmCompleteness: 1,
      })
    ).toBe(100);
  });

  it("adds component scores independently", () => {
    expect(
      computeLocalPresenceScore({
        hasWebsite: true,
        hasPhoneOrEmail: false,
        hasAddressOrCoords: false,
        categoryMatch: false,
        osmCompleteness: 0.5,
      })
    ).toBe(35); // 30 + round(0.5 * 10)
  });
});

describe("signal scores", () => {
  it("computes momentum from signals and social links", () => {
    const signals = makeSignals({
      momentumSignals: makeSignalList(2), // 30
      offerSignals: makeSignalList(1), // 8
      hiringSignals: makeSignalList(1), // 10
      newsSignals: makeSignalList(1), // 10
      socialLinks: { facebook: "https://facebook.example.org/acme" }, // 4
    });
    expect(computeMomentumScore(signals)).toBe(62);
  });

  it("clamps momentum, risk, and change at 100", () => {
    expect(
      computeMomentumScore(makeSignals({ momentumSignals: makeSignalList(10) }))
    ).toBe(100);
    expect(
      computeRiskScore(makeSignals({ riskSignals: makeSignalList(6) }))
    ).toBe(100);
    expect(
      computeChangeScore(makeSignals({ changeSignals: makeSignalList(5) }))
    ).toBe(100);
  });

  it("scales risk and change per signal", () => {
    expect(
      computeRiskScore(makeSignals({ riskSignals: makeSignalList(2) }))
    ).toBe(40);
    expect(
      computeChangeScore(makeSignals({ changeSignals: makeSignalList(2) }))
    ).toBe(50);
  });
});

describe("statusForScore", () => {
  it("maps score bands to statuses", () => {
    expect(statusForScore(85)).toBe("leading");
    expect(statusForScore(80)).toBe("leading");
    expect(statusForScore(70)).toBe("competitive");
    expect(statusForScore(65)).toBe("competitive");
    expect(statusForScore(50)).toBe("behind but recoverable");
    expect(statusForScore(45)).toBe("behind but recoverable");
    expect(statusForScore(30)).toBe("low visibility");
  });
});

describe("rankCompetitors", () => {
  it("ranks user and competitors together by final score", () => {
    const user = makeReport({ name: "You", source: "user", finalScore: 50 });
    const compA = makeReport({ name: "A", source: "overpass", finalScore: 70 });
    const compB = makeReport({ name: "B", source: "mock", finalScore: 30 });

    const ranked = rankCompetitors(user, [compA, compB]);

    expect(ranked.user.rank).toBe(2);
    expect(ranked.competitors.map((c) => c.name)).toEqual(["A", "B"]);
    expect(ranked.competitors.map((c) => c.rank)).toEqual([1, 3]);
  });
});
