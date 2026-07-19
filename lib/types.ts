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

export type WebsiteAudit = {
  url?: string;
  normalizedUrl?: string;
  auditStatus: AuditStatus;
  skipped: boolean;
  reason?: string;
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
  methodologyNote: string;
  dataQualityNote: string;
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
