// Generates a fully synthetic "See a sample report" — a random vertical,
// market, and business identity, benchmarked against jittered mock
// competitor data. No network calls, no real website is ever fetched, and
// every call produces a different result: repeats are not just avoided,
// they're not meaningfully possible given the combinatorics + continuous
// score jitter below.
//
// Reuses the exact same scoring/report/recommendation pipeline as a real
// analysis (finalizeScores, rankCompetitors, buildMarketSummary,
// generateRecommendations, generateBenchmarkReport) so the response shape,
// and everything downstream that renders it, is identical to a real report.

import { finalizeScores } from "./analyze-market";
import { getMockCompetitors } from "./mock-data";
import { generateRecommendations } from "./recommendations";
import { generateBenchmarkReport } from "./report";
import { buildMarketSummary, rankCompetitors, CATEGORY_MAX_SCORES } from "./scoring";
import type {
  AnalyzeMarketRequest,
  AnalyzeMarketResponse,
  CompetitorReport,
  DataQuality,
  SignalScan,
  WebsiteAudit,
} from "./types";

type SampleVertical = {
  businessType: string;
  nameNouns: string[];
};

// businessType strings map to mock-data.ts's bundle aliases; "home services"
// matches none of them, so it deliberately falls through to the
// generic-local-service bundle (mock-data.ts's own documented fallback).
const SAMPLE_VERTICALS: SampleVertical[] = [
  { businessType: "dentist", nameNouns: ["Dental", "Dentistry", "Smiles", "Family Dental"] },
  { businessType: "landscaping", nameNouns: ["Landscaping", "Lawn Care", "Outdoor Living", "Yard Works"] },
  { businessType: "plumbing", nameNouns: ["Plumbing", "Pipe & Drain", "Plumbing Co."] },
  { businessType: "home services", nameNouns: ["Home Services", "Solutions Group", "Services Co."] },
];

const SAMPLE_NAME_ADJECTIVES = [
  "Bright", "Golden", "Summit", "Riverside", "Downtown", "Lakeside",
  "Heritage", "Elm Street", "Northgate", "Cedar Grove", "Hillcrest", "Harbor",
];

const SAMPLE_MARKETS = [
  "Austin, TX", "Denver, CO", "Raleigh, NC", "Boise, ID", "Columbus, OH",
  "Tampa, FL", "Portland, OR", "Nashville, TN", "Salt Lake City, UT", "Richmond, VA",
];

const SAMPLE_BUSINESS_URL = "https://sample-business.example";

function pick<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// Applies small bounded random deltas to a mock competitor's scores so the
// same underlying seed data never produces the same numbers twice.
// websiteScore is recomputed as the sum of the jittered breakdown so the
// two stay internally consistent, mirroring how the real audit derives it.
function jitterCompetitor(competitor: CompetitorReport): CompetitorReport {
  const breakdown = { ...competitor.websiteAudit.scoreBreakdown };
  (Object.keys(breakdown) as (keyof typeof breakdown)[]).forEach((key) => {
    breakdown[key] = clamp(breakdown[key] + randomInt(-3, 3), 0, CATEGORY_MAX_SCORES[key]);
  });
  const websiteScore = Object.values(breakdown).reduce((sum, v) => sum + v, 0);
  const localPresenceScore = clamp(competitor.localPresenceScore + randomInt(-10, 10), 0, 100);

  return {
    ...competitor,
    localPresenceScore,
    websiteAudit: { ...competitor.websiteAudit, websiteScore, scoreBreakdown: breakdown },
  };
}

// Builds the "your business" side of the sample entirely synthetically —
// randomized-but-plausible scores, no live fetch attempted. Follows the
// same skipped:false + reason:"sample-data" + sourceNote convention that
// mock-data.ts already uses for labeled fallback competitor rows, so the
// UI's existing data-quality labeling stays honest without special-casing.
function buildSampleUserReport(businessName: string): CompetitorReport {
  const scoreBreakdown = {
    seo: randomInt(5, 18),
    conversion: randomInt(5, 18),
    trust: randomInt(3, 14),
    content: randomInt(3, 14),
    technical: randomInt(4, 9),
  };
  const websiteScore = Object.values(scoreBreakdown).reduce((sum, v) => sum + v, 0);

  const websiteAudit: WebsiteAudit = {
    url: SAMPLE_BUSINESS_URL,
    normalizedUrl: SAMPLE_BUSINESS_URL,
    skipped: false,
    reason: "sample-data",
    title: `${businessName} | Official Site`,
    metaDescription: `${businessName} — sample business for demonstration.`,
    h1Count: 1,
    headingCount: 3,
    wordCount: 250,
    ctaCount: 1,
    hasPhone: true,
    hasEmail: true,
    hasContactPage: true,
    hasBookingOrQuote: Math.random() > 0.6,
    hasPricingPage: Math.random() > 0.7,
    hasServicesPage: Math.random() > 0.4,
    hasAboutOrTeamPage: true,
    hasBlogOrNewsPage: Math.random() > 0.7,
    hasCareersPage: Math.random() > 0.8,
    hasTestimonials: Math.random() > 0.6,
    hasTrustLanguage: Math.random() > 0.6,
    hasGalleryOrCaseStudy: Math.random() > 0.7,
    hasSocialLinks: Math.random() > 0.5,
    hasViewport: true,
    isHttps: true,
    htmlBytes: 18000,
    fetchMs: 0,
    extractedLinks: [],
    socialLinks: {},
    websiteScore,
    scoreBreakdown,
    evidence: [
      {
        claim: `Randomly generated sample data for ${businessName}.`,
        sourceType: "mock",
        confidence: "low",
      },
    ],
  };

  const signals: SignalScan = {
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
  };

  return {
    id: "sample-user",
    name: businessName,
    website: SAMPLE_BUSINESS_URL,
    source: "user",
    sourceNote: "Randomly generated sample business — not a real analysis.",
    categoryMatchScore: 100,
    localPresenceScore: randomInt(25, 65),
    websiteAudit,
    signals,
    finalScore: 0,
  };
}

export async function generateSampleReport(): Promise<AnalyzeMarketResponse> {
  const vertical = pick(SAMPLE_VERTICALS);
  const market = pick(SAMPLE_MARKETS);
  const businessName = `${pick(SAMPLE_NAME_ADJECTIVES)} ${pick(vertical.nameNouns)}`;

  const input: AnalyzeMarketRequest = {
    businessName,
    businessUrl: SAMPLE_BUSINESS_URL,
    businessType: vertical.businessType,
    market,
    options: { demoMode: "mock" },
  };

  const rawCompetitors = await getMockCompetitors(vertical.businessType, 10);
  const competitors = rawCompetitors.map(jitterCompetitor);
  competitors.forEach(finalizeScores);

  const user = buildSampleUserReport(businessName);
  finalizeScores(user);

  const { user: rankedUser, competitors: rankedCompetitors } = rankCompetitors(
    user,
    competitors
  );

  const summary = buildMarketSummary(rankedUser, rankedCompetitors);
  const recommendations = generateRecommendations({
    user: rankedUser,
    competitors: rankedCompetitors,
  });

  const dataQuality: DataQuality = {
    discoverySource: "mock",
    usedMockData: true,
    liveCompetitorsFound: 0,
    failedHomepageFetches: 0,
    limitedAudits: 0,
    cacheHit: false,
    notes: [
      "This is a randomly generated sample report for demonstration purposes. No real business or website was analyzed.",
    ],
  };

  const report = generateBenchmarkReport({
    input,
    user: rankedUser,
    competitors: rankedCompetitors,
    summary,
    recommendations,
    dataQuality,
  });

  return {
    input,
    market: { label: `${market} (sample report)`, source: "mock" },
    user: rankedUser,
    competitors: rankedCompetitors,
    summary,
    report,
    recommendations,
    dataQuality,
    generatedAt: new Date().toISOString(),
  };
}
