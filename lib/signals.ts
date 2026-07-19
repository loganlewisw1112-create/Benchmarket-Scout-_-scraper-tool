import { dedupeSourceIds } from "./provenance";
import type {
  AuditStatus,
  MarketSignal,
  SignalScan,
  SocialLinks,
  SourceId,
} from "./types";
import type { PageText } from "./audit";

export const KEYWORDS = {
  cta: [
    "call",
    "contact",
    "get started",
    "book",
    "schedule",
    "quote",
    "estimate",
    "request",
    "buy",
    "order",
    "learn more",
    "free consultation",
    "appointment",
  ],
  trust: [
    "testimonial",
    "testimonials",
    "review",
    "reviews",
    "client",
    "clients",
    "case study",
    "results",
    "certified",
    "licensed",
    "insured",
    "award",
    "winner",
    "best of",
    "trusted",
    "guaranteed",
  ],
  momentum: [
    "award",
    "winner",
    "featured",
    "new location",
    "grand opening",
    "expanded",
    "expansion",
    "now hiring",
    "milestone",
    "anniversary",
    "partnered",
    "partnership",
    "new client",
    "best of",
    "top rated",
  ],
  risk: [
    "temporarily closed",
    "reduced hours",
    "apology",
    "delayed",
    "delay",
    "short staffed",
    "complaint",
    "lawsuit",
    "closed location",
    "service disruption",
    "unavailable",
  ],
  change: [
    "under new management",
    "new owner",
    "acquired",
    "acquisition",
    "merger",
    "rebrand",
    "formerly known as",
    "new manager",
    "new team",
    "leadership",
  ],
  offer: [
    "free estimate",
    "same-day quote",
    "financing",
    "monthly plan",
    "emergency service",
    "24/7",
    "guarantee",
    "discount",
    "package",
    "bundle",
    "first month free",
  ],
  hiring: [
    "hiring",
    "careers",
    "jobs",
    "join our team",
    "technician needed",
    "sales rep",
    "crew leader",
    "manager",
    "installer",
    "dispatcher",
  ],
} as const;

function findKeywordHits(text: string, keywords: readonly string[]): string[] {
  const lower = text.toLowerCase();
  return keywords.filter((k) => lower.includes(k));
}

function hitsToSignals(
  hits: string[],
  label: string,
  sourceUrl: string,
  sourceType: MarketSignal["sourceType"],
  sourceIds: SourceId[]
): MarketSignal[] {
  if (hits.length === 0) return [];
  return [
    {
      label,
      evidence: `Public page text includes: "${hits.slice(0, 3).join('", "')}".`,
      sourceUrl,
      sourceType,
      sourceIds,
      confidence: hits.length > 1 ? "medium" : "low",
    },
  ];
}

export function extractMomentumSignals(
  text: string,
  sourceUrl: string,
  sourceType: MarketSignal["sourceType"] = "homepage",
  sourceIds: SourceId[] = []
): MarketSignal[] {
  return hitsToSignals(
    findKeywordHits(text, KEYWORDS.momentum),
    "Momentum language detected",
    sourceUrl,
    sourceType,
    sourceIds
  );
}

export function extractRiskSignals(
  text: string,
  sourceUrl: string,
  sourceType: MarketSignal["sourceType"] = "homepage",
  sourceIds: SourceId[] = []
): MarketSignal[] {
  return hitsToSignals(
    findKeywordHits(text, KEYWORDS.risk),
    "Possible risk language detected",
    sourceUrl,
    sourceType,
    sourceIds
  );
}

export function extractChangeSignals(
  text: string,
  sourceUrl: string,
  sourceType: MarketSignal["sourceType"] = "homepage",
  sourceIds: SourceId[] = []
): MarketSignal[] {
  return hitsToSignals(
    findKeywordHits(text, KEYWORDS.change),
    "Possible company change language detected",
    sourceUrl,
    sourceType,
    sourceIds
  );
}

export function extractOfferSignals(
  text: string,
  sourceUrl: string,
  sourceType: MarketSignal["sourceType"] = "homepage",
  sourceIds: SourceId[] = []
): MarketSignal[] {
  return hitsToSignals(
    findKeywordHits(text, KEYWORDS.offer),
    "Promotional offer language detected",
    sourceUrl,
    sourceType,
    sourceIds
  );
}

export function extractHiringSignals(
  text: string,
  sourceUrl: string,
  sourceType: MarketSignal["sourceType"] = "homepage",
  sourceIds: SourceId[] = []
): MarketSignal[] {
  return hitsToSignals(
    findKeywordHits(text, KEYWORDS.hiring),
    "Hiring-related language detected",
    sourceUrl,
    sourceType,
    sourceIds
  );
}

const SOCIAL_PATTERNS: Array<{
  platform: keyof SocialLinks;
  pattern: RegExp;
}> = [
  { platform: "facebook", pattern: /facebook\.com\/[^\s"'<>]+/i },
  { platform: "instagram", pattern: /instagram\.com\/[^\s"'<>]+/i },
  { platform: "linkedin", pattern: /linkedin\.com\/[^\s"'<>]+/i },
  { platform: "youtube", pattern: /youtube\.com\/[^\s"'<>]+/i },
  { platform: "x", pattern: /(?:x\.com|twitter\.com)\/[^\s"'<>]+/i },
  { platform: "tiktok", pattern: /tiktok\.com\/[^\s"'<>]+/i },
];

export function buildSignalScanFromPageTexts(
  pageTexts: PageText[],
  socialLinks: SocialLinks,
  auditStatus: AuditStatus
): SignalScan {
  const momentumSignals: MarketSignal[] = [];
  const riskSignals: MarketSignal[] = [];
  const changeSignals: MarketSignal[] = [];
  const offerSignals: MarketSignal[] = [];
  const hiringSignals: MarketSignal[] = [];

  for (const page of pageTexts) {
    momentumSignals.push(
      ...extractMomentumSignals(
        page.text,
        page.url,
        page.sourceType,
        page.sourceIds
      )
    );
    riskSignals.push(
      ...extractRiskSignals(page.text, page.url, page.sourceType, page.sourceIds)
    );
    changeSignals.push(
      ...extractChangeSignals(page.text, page.url, page.sourceType, page.sourceIds)
    );
    offerSignals.push(
      ...extractOfferSignals(page.text, page.url, page.sourceType, page.sourceIds)
    );
    hiringSignals.push(
      ...extractHiringSignals(page.text, page.url, page.sourceType, page.sourceIds)
    );
  }

  return {
    auditStatus,
    newsStatus: "not_requested",
    sourceIds: dedupeSourceIds(
      pageTexts.flatMap((page) => page.sourceIds)
    ),
    socialLinks,
    momentumSignals,
    riskSignals,
    changeSignals,
    offerSignals,
    hiringSignals,
    newsSignals: [],
    momentumScore: auditStatus === "unavailable" ? null : 0,
    riskScore: auditStatus === "unavailable" ? null : 0,
    changeScore: auditStatus === "unavailable" ? null : 0,
  };
}

export function extractSocialLinksFromHrefs(hrefs: string[]): SocialLinks {
  const links: SocialLinks = {};

  for (const href of hrefs) {
    for (const { platform, pattern } of SOCIAL_PATTERNS) {
      if (links[platform]) continue;
      const match = href.match(pattern);
      if (match) {
        links[platform] = href.startsWith("http") ? href : `https://${match[0]}`;
      }
    }
  }

  return links;
}
