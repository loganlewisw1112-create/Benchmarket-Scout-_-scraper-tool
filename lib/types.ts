export type AnalyzeMarketRequest = {
  businessName: string;
  businessUrl: string;
  businessType: string;
  market: string;
};

export type SourceId = `S${number}`;
export type AuditStatus = "complete" | "partial" | "unavailable";
export type SourceReference = {
  id: SourceId;
  kind:
    | "user_input"
    | "nominatim"
    | "openstreetmap"
    | "homepage"
    | "linked_page"
    | "news_article";
  provider: string;
  title: string;
  url?: string;
  businessName?: string;
  accessedAt: string;
  status: "used" | "limited" | "unavailable";
};

export type Provenance = {
  policy: "real-only";
  containsSyntheticData: false;
  sources: SourceReference[];
};

export type SocialPlatform =
  | "facebook"
  | "instagram"
  | "linkedin"
  | "youtube"
  | "x"
  | "tiktok";

export type SocialLinks = Partial<Record<SocialPlatform, string>>;

export type ExtractedLinkType =
  | "contact"
  | "booking"
  | "quote"
  | "pricing"
  | "services"
  | "about"
  | "blog"
  | "careers"
  | "social"
  | "other";

export type ExtractedLink = {
  label: string;
  href: string;
  type: ExtractedLinkType;
};

export type ConfidenceLevel = "low" | "medium" | "high";
export type EvidenceSourceType =
  | "homepage"
  | "linked_page"
  | "osm"
  | "gdelt";

export type EvidenceItem = {
  claim: string;
  sourceUrl?: string;
  sourceType: EvidenceSourceType;
  sourceIds: SourceId[];
  confidence: ConfidenceLevel;
};

export type NullableScoreBreakdown = {
  seo: number | null;
  conversion: number | null;
  trust: number | null;
  content: number | null;
  technical: number | null;
};

/**
 * Machine-readable cause of a failed website audit (contract 5). The
 * human-facing text lives in `WebsiteAudit.reason`; see lib/audit.ts.
 */
export type AuditFailureCode =
  | "timeout"
  | "blocked_by_site"
  | "http_error"
  | "dns_unresolved"
  | "dns_error"
  | "tls_error"
  | "connection_failed"
  | "too_large"
  | "unsupported_content_type"
  | "insufficient_content"
  | "robots_disallowed"
  | "too_many_redirects"
  | "invalid_url"
  | "blocked_url";

export type WebsiteAudit = {
  url?: string;
  normalizedUrl?: string;
  auditStatus: AuditStatus;
  skipped: boolean;
  reason?: string;
  /** Set on audits that failed inside the fetch/audit pipeline. */
  reasonCode?: AuditFailureCode;
  sourceIds: SourceId[];

  title?: string;
  metaDescription?: string;
  h1Count: number | null;
  headingCount: number | null;
  wordCount: number | null;

  ctaCount: number | null;
  hasPhone: boolean | null;
  hasEmail: boolean | null;
  hasContactPage: boolean | null;
  hasBookingOrQuote: boolean | null;
  hasPricingPage: boolean | null;
  hasServicesPage: boolean | null;
  hasAboutOrTeamPage: boolean | null;
  hasBlogOrNewsPage: boolean | null;
  hasCareersPage: boolean | null;
  hasTestimonials: boolean | null;
  hasTrustLanguage: boolean | null;
  hasGalleryOrCaseStudy: boolean | null;
  hasSocialLinks: boolean | null;

  hasViewport: boolean | null;
  isHttps: boolean | null;
  htmlBytes: number | null;
  fetchMs: number | null;

  extractedLinks: ExtractedLink[];
  socialLinks: SocialLinks;

  websiteScore: number | null;
  scoreBreakdown: NullableScoreBreakdown;
  evidence: EvidenceItem[];
};

export type MarketSignal = {
  label: string;
  evidence: string;
  sourceUrl: string;
  sourceType: "homepage" | "linked_page" | "social_link" | "news";
  sourceIds: SourceId[];
  observedAt?: string;
  confidence: ConfidenceLevel;
};

export type SignalScan = {
  auditStatus: AuditStatus;
  newsStatus: "complete" | "unavailable" | "not_requested";
  sourceIds: SourceId[];
  socialLinks: SocialLinks;
  momentumSignals: MarketSignal[];
  riskSignals: MarketSignal[];
  changeSignals: MarketSignal[];
  offerSignals: MarketSignal[];
  hiringSignals: MarketSignal[];
  newsSignals: MarketSignal[];
  momentumScore: number | null;
  riskScore: number | null;
  changeScore: number | null;
};

export type CompetitorReport = {
  id: string;
  name: string;
  website?: string;
  phone?: string;
  address?: string;
  lat?: number;
  lon?: number;
  source: "user" | "overpass";
  sourceIds: SourceId[];
  sourceNote?: string;
  auditStatus: AuditStatus;

  categoryMatchScore: number | null;
  localPresenceScore: number | null;
  websiteAudit: WebsiteAudit;
  signals: SignalScan;

  finalScore: number | null;
  rank: number | null;

  /** Distance from the geocoded market center, in km (discovery, contract 6). */
  distanceKm?: number;
  /** Corporate chain / brand location; excluded from ranking (contract 6). */
  isChain?: boolean;
  brand?: string;
  /** True when another scored business shares this exact final score and rank. */
  rankTied?: boolean;
  /** Human-readable reason this record carries no final score or rank. */
  unscoredReason?: string;
};

export type MarketSummary = {
  competitorCount: number;
  auditedCompetitorCount: number;
  competitorAverageWebsiteScore: number | null;
  competitorAverageFinalScore: number | null;
  yourRank: number | null;
  marketGap: number | null;
  status:
    | "leading"
    | "competitive"
    | "behind but recoverable"
    | "low visibility"
    | null;
  strongestCompetitor?: string;
  biggestOpportunity?: string;
  /**
   * Present (2) on reports scored with shared tie ranks, N/A-normalized local
   * presence and momentum, and a position-derived status. Absent on reports
   * stored before that change, which keep their original (v1) semantics.
   */
  scoringVersion?: 2;
  /** True when the user shares its rank with at least one competitor. */
  yourRankTied?: boolean;
};

export type ReportFinding = {
  title: string;
  finding: string;
  evidence: string;
  implication: string;
  sourceIds: SourceId[];
  confidence: ConfidenceLevel;
};

export type CompetitorHighlight = {
  competitorName: string;
  conciseSummary: string;
  strongestVisibleSignal?: string;
  possibleRiskSignal?: string;
  sourceIds: SourceId[];
  confidence: ConfidenceLevel;
};

export type Recommendation = {
  title: string;
  why: string;
  action: string;
  evidence: string;
  sourceIds: SourceId[];
  priority: "high" | "medium" | "low";
};

export type BenchmarkReport = {
  title: string;
  executiveSummary: string;
  positionStatement: string;
  topFindings: ReportFinding[];
  topRisks: ReportFinding[];
  competitorHighlights: CompetitorHighlight[];
  actionPlan: Recommendation[];
  /** Explicit statement shown when actionPlan is empty (e.g. no material gaps). */
  actionPlanNote?: string;
  methodologyNote: string;
  dataQualityNote: string;
};

/**
 * Per-competitor audit outcome counts (the user is reported separately).
 * `failedAudits` on DataQuality counts every record without a usable audit;
 * these split that into what actually happened.
 */
export type AuditOutcomeCounts = {
  scored: number;
  noWebsite: number;
  auditFailed: number;
  notAttempted: number;
  excludedChains: number;
};

export type DataQuality = {
  coverageStatus: AuditStatus;
  realCompetitorsFound: number;
  scoredCompetitors: number;
  failedAudits: number;
  limitedAudits: number;
  unavailableFields: string[];
  cacheHit: boolean;
  notes: string[];
  auditOutcomes?: AuditOutcomeCounts;
  /**
   * Named businesses of this type discovery found within the radius (the
   * user's own listing excluded). `realCompetitorsFound` counts only the ones
   * listed in the report, which is capped.
   */
  discoveredCount?: number;
  /** True when OpenStreetMap hit its result cap, so discoveredCount is a floor. */
  discoveryTruncated?: boolean;
  /**
   * Whether this analysis's website audits checked robots.txt before every
   * fetch (STRICT_ROBOTS=true when it ran). Absent on older reports.
   */
  robotsPolicyEnforced?: boolean;
};

export type AnalyzeMarketResponse = {
  schemaVersion: 2;
  provenance: Provenance;
  input: AnalyzeMarketRequest;

  market: {
    label: string;
    lat: number;
    lon: number;
    bbox?: [number, number, number, number];
    /** Discovery radius actually used, in km (contract 6). */
    radiusKm?: number;
    source: "nominatim";
    sourceIds: SourceId[];
  };

  user: CompetitorReport;
  competitors: CompetitorReport[];
  summary: MarketSummary;
  report: BenchmarkReport;
  recommendations: Recommendation[];
  dataQuality: DataQuality;
  generatedAt: string;
  reportId?: string;
};
