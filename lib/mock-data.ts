import fs from "node:fs/promises";
import path from "node:path";
import type {
  CompetitorReport,
  EvidenceItem,
  MarketSignal,
  SignalScan,
  WebsiteAudit,
} from "./types";

type MockSeedCompetitor = {
  name: string;
  website: string;
  phone: string;
  address: string;
  websiteScore: number;
  localPresenceScore: number;
  scoreBreakdown: {
    seo: number;
    conversion: number;
    trust: number;
    content: number;
    technical: number;
  };
  flags: {
    hasTestimonials: boolean;
    hasBookingOrQuote: boolean;
    hasPricingPage: boolean;
    hasBlogOrNewsPage: boolean;
    hasCareersPage: boolean;
    hasSocialLinks: boolean;
  };
  momentumSignals: { label: string; evidence: string }[];
  offerSignals: { label: string; evidence: string }[];
  hiringSignals: { label: string; evidence: string }[];
  riskSignals: { label: string; evidence: string }[];
  changeSignals: { label: string; evidence: string }[];
  socialLinks: Record<string, string>;
};

type MockBundle = {
  businessType: string;
  market: string;
  competitors: MockSeedCompetitor[];
};

const BUNDLE_ALIASES: Record<string, string> = {
  landscaping: "landscaping",
  landscaper: "landscaping",
  lawn: "landscaping",
  plumber: "plumbing",
  plumbing: "plumbing",
  dentist: "dentist",
  dental: "dentist",
  dentistry: "dentist",
};

export function resolveMockBundleName(businessType: string): string {
  const key = businessType.trim().toLowerCase();
  return BUNDLE_ALIASES[key] ?? "generic-local-service";
}

const bundleCache = new Map<string, MockBundle>();

async function loadBundle(bundleName: string): Promise<MockBundle> {
  if (bundleCache.has(bundleName)) {
    return bundleCache.get(bundleName)!;
  }
  const filePath = path.resolve(
    process.cwd(),
    "data",
    "demo",
    `${bundleName}.json`
  );
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as MockBundle;
  bundleCache.set(bundleName, parsed);
  return parsed;
}

const MOCK_SOURCE_NOTE =
  "Fallback demo row used because free public data was sparse or unavailable.";

function toMockSignals(
  items: { label: string; evidence: string }[]
): MarketSignal[] {
  return items.map((item) => ({
    label: item.label,
    evidence: item.evidence,
    sourceType: "mock",
    confidence: "low",
  }));
}

function buildMockWebsiteAudit(seed: MockSeedCompetitor): WebsiteAudit {
  const evidence: EvidenceItem[] = [
    {
      claim: `Fallback demo data used for ${seed.name}.`,
      sourceType: "mock",
      confidence: "low",
    },
  ];

  return {
    url: seed.website,
    normalizedUrl: seed.website,
    skipped: false,
    reason: "mock-data",
    title: `${seed.name} | Official Site`,
    metaDescription: `${seed.name} — local service provider (demo data).`,
    h1Count: 1,
    headingCount: 4,
    wordCount: 420,
    ctaCount: seed.flags.hasBookingOrQuote ? 3 : 1,
    hasPhone: true,
    hasEmail: true,
    hasContactPage: true,
    hasBookingOrQuote: seed.flags.hasBookingOrQuote,
    hasPricingPage: seed.flags.hasPricingPage,
    hasServicesPage: true,
    hasAboutOrTeamPage: true,
    hasBlogOrNewsPage: seed.flags.hasBlogOrNewsPage,
    hasCareersPage: seed.flags.hasCareersPage,
    hasTestimonials: seed.flags.hasTestimonials,
    hasTrustLanguage: seed.flags.hasTestimonials,
    hasGalleryOrCaseStudy: seed.flags.hasTestimonials,
    hasSocialLinks: seed.flags.hasSocialLinks,
    hasViewport: true,
    isHttps: true,
    htmlBytes: 42000,
    fetchMs: 0,
    extractedLinks: [],
    socialLinks: seed.socialLinks as WebsiteAudit["socialLinks"],
    websiteScore: seed.websiteScore,
    scoreBreakdown: seed.scoreBreakdown,
    evidence,
  };
}

function buildMockSignalScan(seed: MockSeedCompetitor): SignalScan {
  return {
    socialLinks: seed.socialLinks as SignalScan["socialLinks"],
    momentumSignals: toMockSignals(seed.momentumSignals),
    riskSignals: toMockSignals(seed.riskSignals),
    changeSignals: toMockSignals(seed.changeSignals),
    offerSignals: toMockSignals(seed.offerSignals),
    hiringSignals: toMockSignals(seed.hiringSignals),
    newsSignals: [],
    momentumScore: 0,
    riskScore: 0,
    changeScore: 0,
  };
}

export function seedToCompetitorReport(
  seed: MockSeedCompetitor,
  index: number
): CompetitorReport {
  return {
    id: `mock-${index}-${seed.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    name: seed.name,
    website: seed.website,
    phone: seed.phone,
    address: seed.address,
    source: "mock",
    sourceNote: MOCK_SOURCE_NOTE,
    categoryMatchScore: 70,
    localPresenceScore: seed.localPresenceScore,
    websiteAudit: buildMockWebsiteAudit(seed),
    signals: buildMockSignalScan(seed),
    finalScore: 0,
  };
}

export async function getMockCompetitors(
  businessType: string,
  count: number
): Promise<CompetitorReport[]> {
  const bundleName = resolveMockBundleName(businessType);
  const bundle = await loadBundle(bundleName);
  return bundle.competitors
    .slice(0, count)
    .map((seed, idx) => seedToCompetitorReport(seed, idx));
}

export async function getFullMockBundle(
  businessType: string
): Promise<MockBundle> {
  const bundleName = resolveMockBundleName(businessType);
  return loadBundle(bundleName);
}

// Geographic center of the contiguous United States — used only as a
// last-resort placeholder when Nominatim is unavailable.
export const MOCK_MARKET_COORDINATES = {
  lat: 39.8283,
  lon: -98.5795,
};
