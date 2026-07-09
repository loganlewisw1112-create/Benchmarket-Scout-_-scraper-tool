// Shared builders for constructing well-formed CompetitorReport-family
// fixtures in tests. Not a test file itself (doesn't match the
// lib/**/*.test.ts include glob in vitest.config.ts).
import type {
  CompetitorReport,
  MarketSignal,
  MarketSummary,
  SignalScan,
  WebsiteAudit,
} from "./types";

export function makeSignalList(
  count: number,
  labelPrefix = "signal"
): MarketSignal[] {
  return Array.from({ length: count }, (_, i) => ({
    label: `${labelPrefix}-${i}`,
    evidence: "test evidence",
    sourceType: "mock" as const,
    confidence: "low" as const,
  }));
}

export function makeSignals(overrides: Partial<SignalScan> = {}): SignalScan {
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

export function makeAudit(overrides: Partial<WebsiteAudit> = {}): WebsiteAudit {
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
    ...overrides,
  };
}

export function makeReport(args: {
  name: string;
  source: CompetitorReport["source"];
  finalScore: number;
  website?: string;
  websiteAudit?: Partial<WebsiteAudit>;
  signals?: Partial<SignalScan>;
}): CompetitorReport {
  return {
    id: args.name,
    name: args.name,
    website: args.website,
    source: args.source,
    categoryMatchScore: 0,
    localPresenceScore: 0,
    websiteAudit: makeAudit(args.websiteAudit),
    signals: makeSignals(args.signals),
    finalScore: args.finalScore,
  };
}

export function makeSummary(overrides: Partial<MarketSummary> = {}): MarketSummary {
  return {
    competitorCount: 0,
    competitorAverageWebsiteScore: 0,
    competitorAverageFinalScore: 0,
    yourRank: 1,
    marketGap: 0,
    status: "competitive",
    ...overrides,
  };
}
