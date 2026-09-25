import { dedupeSourceIds } from "./provenance";
import type {
  AuditOutcomeCounts,
  CompetitorReport,
  MarketSummary,
  SignalScan,
  SourceId,
  WebsiteAudit,
} from "./types";

export type CategoryKey =
  | "seo"
  | "conversion"
  | "trust"
  | "content"
  | "technical";

export const CATEGORY_MAX_SCORES: Record<CategoryKey, number> = {
  seo: 25,
  conversion: 25,
  trust: 20,
  content: 20,
  technical: 10,
};

export const CATEGORY_LABELS: Record<CategoryKey, string> = {
  seo: "on-page SEO",
  conversion: "conversion elements",
  trust: "trust signals",
  content: "service/location content",
  technical: "technical fundamentals",
};

export const CATEGORY_KEYS = Object.keys(CATEGORY_MAX_SCORES) as CategoryKey[];

/** Scoring semantics version written to MarketSummary.scoringVersion. */
export const SCORING_VERSION = 2 as const;

export const CHAIN_UNSCORED_REASON = "corporate chain website";

export type CategoryComparison = {
  category: CategoryKey;
  userScore: number;
  maxScore: number;
  competitorAverage: number;
  gap: number;
  competitorsAhead: number;
  totalCompetitors: number;
};

function categoryScore(
  report: CompetitorReport,
  category: CategoryKey
): number | null {
  return report.websiteAudit.scoreBreakdown[category];
}

export function computeCategoryComparisons(
  user: CompetitorReport,
  competitors: CompetitorReport[]
): CategoryComparison[] {
  // Only ranked-eligible competitors form the benchmark: failed audits and
  // excluded chains never contribute to an average or a gap.
  const scoredCompetitors = competitors.filter(isScored);
  return CATEGORY_KEYS.flatMap((category) => {
    const userScore = categoryScore(user, category);
    const scores = scoredCompetitors
      .map((competitor) => categoryScore(competitor, category))
      .filter((score): score is number => score !== null);
    if (userScore === null || scores.length === 0) return [];
    const average = scores.reduce((sum, score) => sum + score, 0) / scores.length;
    return [
      {
        category,
        userScore,
        maxScore: CATEGORY_MAX_SCORES[category],
        competitorAverage: Math.round(average * 10) / 10,
        gap: Math.round((average - userScore) * 10) / 10,
        competitorsAhead: scores.filter((score) => score > userScore).length,
        totalCompetitors: scores.length,
      },
    ];
  });
}

/**
 * The observable homepage elements behind each category score. This mirrors
 * computeScoreBreakdown in lib/audit.ts; elements the stored audit cannot
 * re-check (the business-type/city keyword match in SEO and content) are
 * omitted rather than guessed. `observe` returns null when the audit did not
 * observe the element, so it is never read as "missing".
 */
export type AuditElement = {
  key: string;
  category: CategoryKey;
  points: number;
  /** Noun phrase, e.g. "a meta description". */
  label: string;
  /** Imperative recommendation title. */
  title: string;
  action: string;
  observe: (audit: WebsiteAudit) => boolean | null;
  /** When the user also lacks this element, it covers the same fix. */
  coveredBy?: string;
};

function available(audit: WebsiteAudit): boolean {
  return audit.auditStatus !== "unavailable";
}

function either(left: boolean | null, right: boolean | null): boolean | null {
  if (left === true || right === true) return true;
  if (left === null || right === null) return null;
  return false;
}

function atLeast(value: number | null, threshold: number): boolean | null {
  return value === null ? null : value >= threshold;
}

function below(value: number | null, threshold: number): boolean | null {
  return value === null ? null : value < threshold;
}

export const AUDIT_ELEMENTS: AuditElement[] = [
  {
    key: "title",
    category: "seo",
    points: 5,
    label: "a page title",
    title: "Add a descriptive page title",
    action: "Give the homepage a <title> that names the business, its main service, and its area.",
    observe: (audit) => (available(audit) ? Boolean(audit.title?.trim()) : null),
  },
  {
    key: "metaDescription",
    category: "seo",
    points: 5,
    label: "a meta description",
    title: "Add a meta description",
    action: "Write a one- or two-sentence meta description summarizing the service and area.",
    observe: (audit) =>
      available(audit) ? Boolean(audit.metaDescription?.trim()) : null,
  },
  {
    key: "h1",
    category: "seo",
    points: 5,
    label: "an H1 heading",
    title: "Add a clear H1 heading",
    action: "Add one H1 heading on the homepage that states what the business does.",
    observe: (audit) => atLeast(audit.h1Count, 1),
  },
  {
    key: "wordCount",
    category: "seo",
    points: 5,
    label: "at least 300 words of homepage copy",
    title: "Expand the homepage copy",
    action: "Expand the homepage to at least 300 words describing services, area, and process.",
    observe: (audit) => atLeast(audit.wordCount, 300),
  },
  {
    key: "cta",
    category: "conversion",
    points: 8,
    label: "at least two calls to action",
    title: "Add clear calls to action",
    action: "Add at least two visible calls to action (for example \"Call now\" or \"Book an appointment\").",
    observe: (audit) => atLeast(audit.ctaCount, 2),
  },
  {
    key: "contactDetails",
    category: "conversion",
    points: 7,
    label: "a visible phone number or email address",
    title: "Show a phone number or email address",
    action: "Show a phone number or email address on the homepage.",
    observe: (audit) => either(audit.hasPhone, audit.hasEmail),
  },
  {
    key: "contactPath",
    category: "conversion",
    points: 5,
    label: "a contact page or booking/quote path",
    title: "Add a contact or booking path",
    action: "Link a contact page or a booking/quote request form from the homepage.",
    observe: (audit) => either(audit.hasContactPage, audit.hasBookingOrQuote),
  },
  {
    key: "offerPage",
    category: "conversion",
    points: 5,
    label: "a linked services or pricing page",
    title: "Link a services or pricing page",
    action: "Link a services or pricing page from the homepage.",
    observe: (audit) => either(audit.hasServicesPage, audit.hasPricingPage),
    coveredBy: "servicesPage",
  },
  {
    key: "testimonials",
    category: "trust",
    points: 8,
    label: "testimonials or client reviews",
    title: "Show testimonials or client reviews",
    action: "Add real testimonials or client reviews to the homepage.",
    observe: (audit) => audit.hasTestimonials,
  },
  {
    key: "trustLanguage",
    category: "trust",
    points: 4,
    label: "credential language (licensed, insured, certified, awards)",
    title: "State credentials",
    action: "State verifiable credentials such as licenses, insurance, certifications, or awards.",
    observe: (audit) => audit.hasTrustLanguage,
  },
  {
    key: "aboutPage",
    category: "trust",
    points: 4,
    label: "a linked about or team page",
    title: "Link an about or team page",
    action: "Add an about or team page and link it from the homepage.",
    observe: (audit) => audit.hasAboutOrTeamPage,
  },
  {
    key: "gallery",
    category: "trust",
    points: 4,
    label: "a gallery, portfolio, or case study",
    title: "Show examples of past work",
    action: "Add a gallery, portfolio, or case study showing past work.",
    observe: (audit) => audit.hasGalleryOrCaseStudy,
  },
  {
    key: "servicesPage",
    category: "content",
    points: 8,
    label: "a linked services page",
    title: "Add a dedicated services page",
    action: "Publish a dedicated services page and link it from the homepage.",
    observe: (audit) => audit.hasServicesPage,
  },
  {
    key: "blog",
    category: "content",
    points: 4,
    label: "a linked blog or news page",
    title: "Add a blog or news page",
    action: "Add a blog or news page and link it from the homepage.",
    observe: (audit) => audit.hasBlogOrNewsPage,
  },
  {
    key: "headings",
    category: "content",
    points: 4,
    label: "at least three headings",
    title: "Structure the homepage with headings",
    action: "Break the homepage into at least three headed sections.",
    observe: (audit) => atLeast(audit.headingCount, 3),
  },
  {
    key: "viewport",
    category: "technical",
    points: 3,
    label: "a mobile viewport tag",
    title: "Add a mobile viewport tag",
    action: "Add a responsive viewport meta tag so the homepage renders correctly on phones.",
    observe: (audit) => audit.hasViewport,
  },
  {
    key: "speed",
    category: "technical",
    points: 3,
    label: "a homepage response under 2.5 seconds",
    title: "Speed up the homepage response",
    action: "Reduce homepage response time below 2.5 seconds (hosting, caching, or page weight).",
    observe: (audit) => below(audit.fetchMs, 2500),
  },
  {
    key: "pageSize",
    category: "technical",
    points: 2,
    label: "homepage HTML under 1 MB",
    title: "Reduce homepage HTML size",
    action: "Reduce the homepage HTML below 1 MB.",
    observe: (audit) => below(audit.htmlBytes, 1024 * 1024),
  },
  {
    key: "https",
    category: "technical",
    points: 2,
    label: "HTTPS",
    title: "Serve the site over HTTPS",
    action: "Serve the homepage over HTTPS and redirect HTTP to it.",
    observe: (audit) => audit.isHttps,
  },
];

/**
 * Source IDs for the pages whose observations produced an entity's audit
 * fields: successful homepage fetches, never failed linked-page attempts or
 * news searches. Falls back to the entity's primary homepage source.
 */
export function auditObservationSourceIds(report: CompetitorReport): SourceId[] {
  const observed = report.websiteAudit.evidence
    .filter(
      (item) => item.sourceType === "homepage" && item.confidence !== "low"
    )
    .flatMap((item) => item.sourceIds);
  if (observed.length > 0) return dedupeSourceIds(observed);
  return report.websiteAudit.sourceIds.slice(0, 1);
}

/**
 * Momentum is the share of available momentum evidence that was observed.
 * Each evidence class has a cap. A class that could not be observed for an
 * entity (news when the GDELT search was unavailable or not requested) is
 * N/A: it is removed from both the points earned and the maximum, and the
 * remainder is normalized to 0-100. Unavailable news is never scored as zero.
 * `countNews: false` treats news as N/A even when it was observed, so a
 * report can leave news out for every entity when it could not search news
 * for every scored one.
 */
const MOMENTUM_COMPONENT_MAX = {
  siteLanguage: 55,
  socialProfiles: 20,
  news: 25,
} as const;

export function computeMomentumScore(
  signals: SignalScan,
  options: { countNews?: boolean } = {}
): number | null {
  if (signals.auditStatus === "unavailable") return null;
  const newsObserved =
    signals.newsStatus === "complete" && options.countNews !== false;
  const earned =
    Math.min(
      MOMENTUM_COMPONENT_MAX.siteLanguage,
      signals.momentumSignals.length * 15 +
        signals.offerSignals.length * 8 +
        signals.hiringSignals.length * 10
    ) +
    Math.min(
      MOMENTUM_COMPONENT_MAX.socialProfiles,
      Object.keys(signals.socialLinks).length * 4
    ) +
    (newsObserved
      ? Math.min(MOMENTUM_COMPONENT_MAX.news, signals.newsSignals.length * 10)
      : 0);
  const max =
    MOMENTUM_COMPONENT_MAX.siteLanguage +
    MOMENTUM_COMPONENT_MAX.socialProfiles +
    (newsObserved ? MOMENTUM_COMPONENT_MAX.news : 0);
  return Math.round((earned / max) * 100);
}

export function computeRiskScore(signals: SignalScan): number | null {
  return signals.auditStatus === "unavailable"
    ? null
    : Math.min(100, signals.riskSignals.length * 20);
}

export function computeChangeScore(signals: SignalScan): number | null {
  return signals.auditStatus === "unavailable"
    ? null
    : Math.min(100, signals.changeSignals.length * 25);
}

export function computeFinalScore(args: {
  websiteScore: number | null;
  localPresenceScore: number | null;
  momentumScore: number | null;
  riskScore: number | null;
}): number | null {
  const values = [
    args.websiteScore,
    args.localPresenceScore,
    args.momentumScore,
    args.riskScore,
  ];
  if (values.some((value) => value === null)) return null;
  return Math.round(
    0.6 * args.websiteScore! +
      0.2 * args.localPresenceScore! +
      0.15 * args.momentumScore! +
      0.05 * (100 - args.riskScore!)
  );
}

/**
 * Local presence inputs. `null` means the input could not be observed for
 * this entity (N/A), which is different from an observed `false`/0.
 * `categoryMatch` may be a match strength in [0, 1] (see computeCategoryMatch).
 */
export type LocalPresenceInputs = {
  hasWebsite: boolean | null;
  hasPhoneOrEmail: boolean | null;
  hasAddressOrCoords: boolean | null;
  categoryMatch: boolean | number | null;
  osmCompleteness: number | null;
};

const LOCAL_PRESENCE_WEIGHTS: Record<keyof LocalPresenceInputs, number> = {
  hasWebsite: 30,
  hasPhoneOrEmail: 20,
  hasAddressOrCoords: 20,
  categoryMatch: 20,
  osmCompleteness: 10,
};

/**
 * Local presence uses one formula for the user and every competitor, from the
 * same evidence classes: website listed, public contact details (directory
 * record or homepage audit), address/coordinates, directory category match,
 * and directory-record completeness.
 *
 * Every input that is unavailable for an entity is N/A: its weight is removed
 * from both the points earned and the maximum, and the score is normalized to
 * 0-100 over the inputs that were observed. For example, the user's own
 * directory record is usually not matched, so its address, category and
 * completeness inputs are N/A and it is scored on website + contact details
 * alone. Unobserved inputs are never capped, zeroed, or backfilled, which is
 * what previously held the user at 70 while directory-listed competitors could
 * reach 100. Returns null only when no input is observable.
 */
export function computeLocalPresenceScore(
  args: LocalPresenceInputs
): number | null {
  let earned = 0;
  let max = 0;
  for (const key of Object.keys(LOCAL_PRESENCE_WEIGHTS) as Array<
    keyof LocalPresenceInputs
  >) {
    const value = args[key];
    if (value === null || value === undefined) continue;
    if (typeof value === "number" && !Number.isFinite(value)) continue;
    const weight = LOCAL_PRESENCE_WEIGHTS[key];
    const fraction =
      typeof value === "boolean" ? (value ? 1 : 0) : Math.max(0, Math.min(1, value));
    earned += fraction * weight;
    max += weight;
  }
  if (max === 0) return null;
  return Math.round((earned / max) * 100);
}

/** Phone or email observed on the audited homepage; null when not observed. */
export function observedContactDetails(audit: WebsiteAudit): boolean | null {
  return either(audit.hasPhone, audit.hasEmail);
}

/**
 * Category match strength from the entity's actual OpenStreetMap tags against
 * the tags the business type resolved to:
 *   - null: the entity's tags are not known (N/A, excluded from local presence)
 *   - 0:    none of its tags match the resolved category tags
 *   - 0.5:  it matches a resolved tag, but nothing in its tags or name names
 *           the business type itself (e.g. a gym found for "yoga studio")
 *   - 1:    it matches a resolved tag and its tags or name name the type
 */
export function computeCategoryMatch(
  elementTags: Record<string, string> | null | undefined,
  resolvedTags: ReadonlyArray<readonly [string, string]>,
  businessType: string
): number | null {
  if (!elementTags || resolvedTags.length === 0) return null;
  const tagValues = (key: string): string[] =>
    (elementTags[key] ?? "")
      .split(";")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
  const matchesResolved = resolvedTags.some(([key, value]) =>
    tagValues(key).includes(value.toLowerCase())
  );
  if (!matchesResolved) return 0;
  const haystack = Object.values(elementTags)
    .join(" ")
    .toLowerCase()
    .replace(/[_;:]+/g, " ");
  const typeWords = businessType
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3);
  return typeWords.some((word) => haystack.includes(word)) ? 1 : 0.5;
}

/** Legacy (scoring v1) absolute score band. Kept for stored v1 reports. */
export function statusForScore(score: number): NonNullable<MarketSummary["status"]> {
  if (score >= 80) return "leading";
  if (score >= 65) return "competitive";
  if (score >= 45) return "behind but recoverable";
  return "low visibility";
}

/** Gap (user minus competitor average) below which the status is "low visibility". */
export const LOW_VISIBILITY_GAP = -15;

/**
 * Position status derived from the user's relative position, so it can never
 * contradict the rank or market gap shown next to it:
 *   - rank #1 (including tied for #1)          -> leading
 *   - at or above the scored-competitor average -> competitive
 *   - below average by up to 15 points          -> behind but recoverable
 *   - more than 15 points below average         -> low visibility
 * `gap` is the unrounded user score minus the competitor average. Null when
 * the user is unranked or there is no scored competitor.
 */
export function statusForPosition(args: {
  rank: number | null;
  gap: number | null;
}): MarketSummary["status"] {
  if (args.rank === null || args.gap === null) return null;
  if (args.rank === 1) return "leading";
  if (args.gap >= 0) return "competitive";
  if (args.gap >= LOW_VISIBILITY_GAP) return "behind but recoverable";
  return "low visibility";
}

/**
 * The status to display for a stored summary. Reports scored before v2 stored
 * an absolute score band that could contradict the rank (e.g. last place shown
 * as "competitive"), so for those the status is re-derived from rank and gap.
 * Shared by the on-screen report and the PDF.
 */
export function displayStatusForSummary(
  summary: MarketSummary
): MarketSummary["status"] {
  if (summary.scoringVersion === SCORING_VERSION) return summary.status;
  return statusForPosition({ rank: summary.yourRank, gap: summary.marketGap });
}

export function isScored(report: CompetitorReport): boolean {
  return (
    report.auditStatus !== "unavailable" &&
    report.finalScore !== null &&
    report.isChain !== true
  );
}

export type AuditOutcomeKind =
  | "scored"
  | "no_website"
  | "audit_failed"
  | "not_attempted"
  | "excluded_chain";

/** Map internal failure codes to readable text; free-text reasons pass through. */
export function humanizeAuditReason(reason: string | undefined): string {
  if (!reason) return "the homepage could not be fetched";
  const normalized = reason.trim();
  const known: Record<string, string> = {
    insufficient_content: "the homepage had too little readable content",
    dns_unresolved: "the domain did not resolve",
    dns_error: "the domain lookup failed",
  };
  if (known[normalized]) return known[normalized];
  if (/^[a-z]+(?:_[a-z]+)+$/.test(normalized)) return normalized.replace(/_/g, " ");
  // Audit reasons are sentence-cased ("Domain does not resolve"); they are
  // shown mid-sentence, so lower-case the first word unless it is an acronym.
  const text = normalized.replace(/\.$/, "");
  return /^[A-Z][a-z]/.test(text) ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}

/**
 * What happened to an entity's audit. "No website" and "not attempted" are
 * not audit failures: nothing was fetched. Records that were never fetched
 * have no homepage source; attempted-but-failed records keep theirs.
 */
export function classifyAuditOutcome(report: CompetitorReport): {
  kind: AuditOutcomeKind;
  reason?: string;
} {
  if (report.isChain) return { kind: "excluded_chain", reason: CHAIN_UNSCORED_REASON };
  if (isScored(report)) return { kind: "scored" };
  if (report.source !== "user" && !report.website) {
    return { kind: "no_website", reason: "no website listed" };
  }
  const reason = report.websiteAudit.reason;
  if (
    report.websiteAudit.sourceIds.length === 0 ||
    /not selected/i.test(reason ?? "")
  ) {
    return { kind: "not_attempted", reason: "not audited (report audit limit)" };
  }
  return {
    kind: "audit_failed",
    reason: `website audit failed: ${humanizeAuditReason(reason)}`,
  };
}

export function countAuditOutcomes(records: CompetitorReport[]): AuditOutcomeCounts {
  const counts: AuditOutcomeCounts = {
    scored: 0,
    noWebsite: 0,
    auditFailed: 0,
    notAttempted: 0,
    excludedChains: 0,
  };
  for (const record of records) {
    const { kind } = classifyAuditOutcome(record);
    if (kind === "scored") counts.scored += 1;
    else if (kind === "no_website") counts.noWebsite += 1;
    else if (kind === "audit_failed") counts.auditFailed += 1;
    else if (kind === "not_attempted") counts.notAttempted += 1;
    else counts.excludedChains += 1;
  }
  return counts;
}

function byScoreThenUser(user: CompetitorReport) {
  return (left: CompetitorReport, right: CompetitorReport): number =>
    right.finalScore! - left.finalScore! ||
    (left === user ? -1 : right === user ? 1 : 0) ||
    left.id.localeCompare(right.id);
}

/**
 * Competition ranking ("1224"): an entity's rank is 1 + the number of scored
 * entities with a strictly higher final score, so equal scores share a rank
 * and are flagged `rankTied`. Ties are never broken against the user; within
 * a tie the user is listed first. Ranks are only assigned when at least two
 * entities are scored; a lone scored entity has nothing to be ranked against.
 * Corporate chain locations are excluded from ranking and left unscored.
 */
export function rankCompetitors(
  user: CompetitorReport,
  competitors: CompetitorReport[]
): { user: CompetitorReport; competitors: CompetitorReport[] } {
  const all = [user, ...competitors];
  for (const report of all) {
    report.rank = null;
    delete report.rankTied;
    if (report.isChain) report.finalScore = null;
    const outcome = classifyAuditOutcome(report);
    if (outcome.kind === "scored") delete report.unscoredReason;
    else report.unscoredReason = outcome.reason;
  }
  const scored = all.filter(isScored);
  if (scored.length >= 2) {
    for (const report of scored) {
      report.rank =
        1 + scored.filter((other) => other.finalScore! > report.finalScore!).length;
      if (
        scored.some(
          (other) => other !== report && other.finalScore === report.finalScore
        )
      ) {
        report.rankTied = true;
      }
    }
  }

  return {
    user,
    competitors: [
      ...competitors.filter(isScored).sort(byScoreThenUser(user)),
      ...competitors.filter((competitor) => !isScored(competitor)),
    ],
  };
}

/**
 * The user's weakest category by share of its maximum, skipping categories
 * already at maximum. Undefined when every observed category is maxed.
 */
export function biggestOpportunityCategory(
  report: CompetitorReport
): CategoryKey | undefined {
  return CATEGORY_KEYS.flatMap((category) => {
    const score = report.websiteAudit.scoreBreakdown[category];
    const max = CATEGORY_MAX_SCORES[category];
    return score === null || score >= max ? [] : [{ category, share: score / max, max }];
  }).sort((left, right) => left.share - right.share || right.max - left.max)[0]
    ?.category;
}

export function buildMarketSummary(
  user: CompetitorReport,
  competitors: CompetitorReport[]
): MarketSummary {
  const scored = competitors.filter(isScored);
  const averageWebsite = scored.length
    ? scored.reduce((sum, report) => sum + report.websiteAudit.websiteScore!, 0) /
      scored.length
    : null;
  const averageFinal = scored.length
    ? scored.reduce((sum, report) => sum + report.finalScore!, 0) / scored.length
    : null;
  const strongest = [...scored].sort(byScoreThenUser(user))[0];
  const rawGap =
    isScored(user) && averageFinal !== null ? user.finalScore! - averageFinal : null;

  return {
    competitorCount: competitors.length,
    auditedCompetitorCount: scored.length,
    competitorAverageWebsiteScore:
      averageWebsite === null ? null : Math.round(averageWebsite),
    competitorAverageFinalScore:
      averageFinal === null ? null : Math.round(averageFinal),
    yourRank: user.rank,
    // `|| 0` normalizes Math.round(-0.3) === -0, which would render as "+0".
    marketGap: rawGap === null ? null : Math.round(rawGap) || 0,
    status: statusForPosition({ rank: user.rank, gap: rawGap }),
    strongestCompetitor: strongest?.name,
    biggestOpportunity: biggestOpportunityCategory(user),
    scoringVersion: SCORING_VERSION,
    ...(user.rankTied ? { yourRankTied: true } : {}),
  };
}

/** "#3", "tied for #3", or "N/A" for display. */
export function formatRank(rank: number | null, tied?: boolean): string {
  if (rank === null) return "N/A";
  return tied ? `tied for #${rank}` : `#${rank}`;
}
