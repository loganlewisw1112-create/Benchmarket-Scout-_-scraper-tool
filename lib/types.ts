export type DemoMode = "live" | "auto" | "mock";

export type AnalyzeMarketRequest = {
  businessName: string;
  businessUrl: string;
  businessType: string;
  market: string;
  options?: {
    demoMode?: DemoMode;
  };
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

export type EvidenceItem = {
  claim: string;
  sourceUrl?: string;
  sourceType: "homepage" | "linked_page" | "osm" | "gdelt" | "mock";
  confidence: ConfidenceLevel;
};

export type WebsiteAudit = {
  url?: string;
  normalizedUrl?: string;
  skipped: boolean;
  reason?: string;

  title?: string;
  metaDescription?: string;
  h1Count: number;
  headingCount: number;
  wordCount: number;

  ctaCount: number;
  hasPhone: boolean;
  hasEmail: boolean;
  hasContactPage: boolean;
  hasBookingOrQuote: boolean;
  hasPricingPage: boolean;
  hasServicesPage: boolean;
  hasAboutOrTeamPage: boolean;
  hasBlogOrNewsPage: boolean;
  hasCareersPage: boolean;
  hasTestimonials: boolean;
  hasTrustLanguage: boolean;
  hasGalleryOrCaseStudy: boolean;
  hasSocialLinks: boolean;

  hasViewport: boolean;
  isHttps: boolean;
  htmlBytes: number;
  fetchMs: number;

  extractedLinks: ExtractedLink[];
  socialLinks: SocialLinks;

  websiteScore: number;

  scoreBreakdown: {
    seo: number;
    conversion: number;
    trust: number;
    content: number;
    technical: number;
  };

  evidence: EvidenceItem[];
};

export type MarketSignal = {
  label: string;
  evidence: string;
  sourceUrl?: string;
  sourceType: "homepage" | "linked_page" | "social_link" | "news" | "mock";
  confidence: ConfidenceLevel;
};

export type SignalScan = {
  socialLinks: SocialLinks;
  momentumSignals: MarketSignal[];
  riskSignals: MarketSignal[];
  changeSignals: MarketSignal[];
  offerSignals: MarketSignal[];
  hiringSignals: MarketSignal[];
  newsSignals: MarketSignal[];
  momentumScore: number;
  riskScore: number;
  changeScore: number;
};

export type CompetitorReport = {
  id: string;
  name: string;
  website?: string;
  phone?: string;
  address?: string;
  lat?: number;
  lon?: number;
  source: "user" | "overpass" | "mock";
  sourceNote?: string;

  categoryMatchScore: number;
  localPresenceScore: number;

  websiteAudit: WebsiteAudit;
  signals: SignalScan;

  finalScore: number;
  rank?: number;
};

export type MarketSummary = {
  competitorCount: number;
  competitorAverageWebsiteScore: number;
  competitorAverageFinalScore: number;
  yourRank: number;
  marketGap: number;
  status:
    | "leading"
    | "competitive"
    | "behind but recoverable"
    | "low visibility";
  strongestCompetitor?: string;
  biggestOpportunity?: string;
};

export type ReportFinding = {
  title: string;
  finding: string;
  evidence: string;
  implication: string;
  confidence: ConfidenceLevel;
};

export type CompetitorHighlight = {
  competitorName: string;
  conciseSummary: string;
  strongestVisibleSignal?: string;
  possibleRiskSignal?: string;
  confidence: ConfidenceLevel;
};

export type Recommendation = {
  title: string;
  why: string;
  action: string;
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
  discoverySource: "overpass" | "mock" | "mixed";
  usedMockData: boolean;
  liveCompetitorsFound: number;
  failedHomepageFetches: number;
  limitedAudits: number;
  cacheHit: boolean;
  notes: string[];
};

export type AnalyzeMarketResponse = {
  input: AnalyzeMarketRequest;

  market: {
    label: string;
    lat?: number;
    lon?: number;
    bbox?: [number, number, number, number];
    source: "nominatim" | "mock";
  };

  user: CompetitorReport;
  competitors: CompetitorReport[];

  summary: MarketSummary;
  report: BenchmarkReport;
  recommendations: Recommendation[];

  dataQuality: DataQuality;

  generatedAt: string;
};
