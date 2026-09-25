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
  // Momentum/risk/change/hiring lists hold only phrases that make a specific
  // claim on their own. Generic words that appear in ordinary site copy or
  // navigation ("featured", "new client", "unavailable", "delay",
  // "complaint", "leadership", "manager", "jobs", "careers", "package",
  // bare "hiring") were removed: they labelled real businesses with risk or
  // hiring claims that the page did not make.
  momentum: [
    "award",
    "winner",
    "featured in",
    "new location",
    "grand opening",
    "expanded",
    "expansion",
    "now hiring",
    "milestone",
    "anniversary",
    "partnered",
    "partnership",
    "best of",
    "top rated",
  ],
  risk: [
    "temporarily closed",
    "closed temporarily",
    "permanently closed",
    "reduced hours",
    "short staffed",
    "short-staffed",
    "lawsuit",
    "closed location",
    "service disruption",
  ],
  change: [
    "under new management",
    "under new ownership",
    "new owner",
    "new ownership",
    "acquired by",
    "merger",
    "merged with",
    "rebrand",
    "rebranded",
    "formerly known as",
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
    "bundle",
    "first month free",
  ],
  hiring: [
    "now hiring",
    "we're hiring",
    "we are hiring",
    "hiring now",
    "join our team",
    "job openings",
    "open positions",
    "technician needed",
    "crew leader",
  ],
} as const;

const keywordPatternCache = new Map<string, RegExp>();

/**
 * Whole-word/phrase matcher: "call" does not match "locally", "book" does not
 * match "Facebook", "rebrand" does not match "Firebrand". A trailing plural
 * "s" is allowed ("award" matches "awards"). Whitespace inside a phrase
 * matches any run of whitespace.
 */
function keywordPattern(keyword: string): RegExp {
  let pattern = keywordPatternCache.get(keyword);
  if (!pattern) {
    const body = keyword
      .toLowerCase()
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\s+/g, "\\s+");
    pattern = new RegExp(`(?<![a-z0-9])${body}s?(?![a-z0-9])`, "g");
    keywordPatternCache.set(keyword, pattern);
  }
  pattern.lastIndex = 0;
  return pattern;
}

function normalizeForMatching(text: string): string {
  return text.toLowerCase().replace(/[\u2018\u2019\u02bc]/g, "'");
}

export function countKeywordMatches(
  text: string,
  keywords: readonly string[]
): number {
  const normalized = normalizeForMatching(text);
  let count = 0;
  for (const keyword of keywords) {
    count += normalized.match(keywordPattern(keyword))?.length ?? 0;
  }
  return count;
}

function findKeywordHits(text: string, keywords: readonly string[]): string[] {
  const normalized = normalizeForMatching(text);
  return keywords.filter((k) => keywordPattern(k).test(normalized));
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

type SignalCategory = {
  keywords: readonly string[];
  label: string;
};

const SIGNAL_CATEGORIES = {
  momentum: { keywords: KEYWORDS.momentum, label: "Momentum language detected" },
  risk: { keywords: KEYWORDS.risk, label: "Possible risk language detected" },
  change: {
    keywords: KEYWORDS.change,
    label: "Possible company change language detected",
  },
  offer: { keywords: KEYWORDS.offer, label: "Promotional offer language detected" },
  hiring: { keywords: KEYWORDS.hiring, label: "Hiring-related language detected" },
} satisfies Record<string, SignalCategory>;

export function extractMomentumSignals(
  text: string,
  sourceUrl: string,
  sourceType: MarketSignal["sourceType"] = "homepage",
  sourceIds: SourceId[] = []
): MarketSignal[] {
  return hitsToSignals(
    findKeywordHits(text, SIGNAL_CATEGORIES.momentum.keywords),
    SIGNAL_CATEGORIES.momentum.label,
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
    findKeywordHits(text, SIGNAL_CATEGORIES.risk.keywords),
    SIGNAL_CATEGORIES.risk.label,
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
    findKeywordHits(text, SIGNAL_CATEGORIES.change.keywords),
    SIGNAL_CATEGORIES.change.label,
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
    findKeywordHits(text, SIGNAL_CATEGORIES.offer.keywords),
    SIGNAL_CATEGORIES.offer.label,
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
    findKeywordHits(text, SIGNAL_CATEGORIES.hiring.keywords),
    SIGNAL_CATEGORIES.hiring.label,
    sourceUrl,
    sourceType,
    sourceIds
  );
}

// Exact social hosts (and their subdomains such as www./m./uk.). Substring
// matching let "wix.com" or "fedex.com" count as an x.com profile.
const SOCIAL_HOSTS: Array<{
  platform: keyof SocialLinks;
  hosts: readonly string[];
}> = [
  { platform: "facebook", hosts: ["facebook.com", "fb.com"] },
  { platform: "instagram", hosts: ["instagram.com"] },
  { platform: "linkedin", hosts: ["linkedin.com"] },
  { platform: "youtube", hosts: ["youtube.com", "youtu.be"] },
  { platform: "x", hosts: ["x.com", "twitter.com"] },
  { platform: "tiktok", hosts: ["tiktok.com"] },
];

// Share buttons, intent/dialog endpoints, and embeds point at a social
// network but are not the business's own profile (e.g. facebook.com/sharer.php,
// facebook.com/dialog/feed, twitter.com/intent/tweet, twitter.com/share,
// linkedin.com/shareArticle, youtube.com/embed/...).
const NON_PROFILE_PATH =
  /^\/(?:sharer|share|sharearticle|sharing|dialog|intent|plugins|embed|home|login|cws\/share)(?:[/.?]|$)/i;

function socialPlatformForUrl(href: string): keyof SocialLinks | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.pathname === "/" || url.pathname === "") return null;
  if (NON_PROFILE_PATH.test(url.pathname)) return null;

  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  for (const { platform, hosts } of SOCIAL_HOSTS) {
    if (hosts.some((h) => host === h || host.endsWith(`.${h}`))) {
      return platform;
    }
  }
  return null;
}

/** True for a link to a social network host (profile or not). */
export function isSocialNetworkUrl(href: string): boolean {
  try {
    const host = new URL(href).hostname.toLowerCase().replace(/\.$/, "");
    return SOCIAL_HOSTS.some(({ hosts }) =>
      hosts.some((h) => host === h || host.endsWith(`.${h}`))
    );
  } catch {
    return false;
  }
}

/**
 * One signal per category per site. A keyword counts once no matter how many
 * crawled pages repeat it, so the number of pages fetched cannot inflate a
 * score. The signal cites the first page with a hit; its sourceIds cover
 * every page that contributed a distinct keyword.
 */
function aggregateSiteSignals(
  pageTexts: PageText[],
  category: SignalCategory
): MarketSignal[] {
  const hits: string[] = [];
  const sourceIds: SourceId[] = [];
  let firstPage: PageText | undefined;

  for (const page of pageTexts) {
    const newHits = findKeywordHits(page.text, category.keywords).filter(
      (hit) => !hits.includes(hit)
    );
    if (newHits.length === 0) continue;
    hits.push(...newHits);
    sourceIds.push(...page.sourceIds);
    firstPage ??= page;
  }

  if (!firstPage) return [];
  return hitsToSignals(
    hits,
    category.label,
    firstPage.url,
    firstPage.sourceType,
    dedupeSourceIds(sourceIds)
  );
}

export function buildSignalScanFromPageTexts(
  pageTexts: PageText[],
  socialLinks: SocialLinks,
  auditStatus: AuditStatus
): SignalScan {
  return {
    auditStatus,
    newsStatus: "not_requested",
    sourceIds: dedupeSourceIds(
      pageTexts.flatMap((page) => page.sourceIds)
    ),
    socialLinks,
    momentumSignals: aggregateSiteSignals(pageTexts, SIGNAL_CATEGORIES.momentum),
    riskSignals: aggregateSiteSignals(pageTexts, SIGNAL_CATEGORIES.risk),
    changeSignals: aggregateSiteSignals(pageTexts, SIGNAL_CATEGORIES.change),
    offerSignals: aggregateSiteSignals(pageTexts, SIGNAL_CATEGORIES.offer),
    hiringSignals: aggregateSiteSignals(pageTexts, SIGNAL_CATEGORIES.hiring),
    newsSignals: [],
    momentumScore: auditStatus === "unavailable" ? null : 0,
    riskScore: auditStatus === "unavailable" ? null : 0,
    changeScore: auditStatus === "unavailable" ? null : 0,
  };
}

export function extractSocialLinksFromHrefs(hrefs: string[]): SocialLinks {
  const links: SocialLinks = {};

  for (const href of hrefs) {
    const platform = socialPlatformForUrl(href);
    if (platform && !links[platform]) links[platform] = href;
  }

  return links;
}
