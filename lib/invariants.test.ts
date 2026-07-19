import { describe, expect, it } from "vitest";
import { assertRealDataResponse, RealDataInvariantError } from "./invariants";
import type {
  AnalyzeMarketResponse,
  Recommendation,
  WebsiteAudit,
} from "./types";

function minimalResponse(): AnalyzeMarketResponse {
  const audit: WebsiteAudit = {
    url: "https://acme.example/",
    normalizedUrl: "https://acme.example/",
    auditStatus: "complete",
    skipped: false,
    sourceIds: ["S3"],
    title: "Acme",
    h1Count: 1,
    headingCount: 1,
    wordCount: 100,
    ctaCount: 1,
    hasPhone: true,
    hasEmail: false,
    hasContactPage: true,
    hasBookingOrQuote: false,
    hasPricingPage: false,
    hasServicesPage: true,
    hasAboutOrTeamPage: false,
    hasBlogOrNewsPage: false,
    hasCareersPage: false,
    hasTestimonials: false,
    hasTrustLanguage: false,
    hasGalleryOrCaseStudy: false,
    hasSocialLinks: false,
    hasViewport: true,
    isHttps: true,
    htmlBytes: 1_000,
    fetchMs: 100,
    extractedLinks: [],
    socialLinks: {},
    websiteScore: 50,
    scoreBreakdown: {
      seo: 15,
      conversion: 10,
      trust: 5,
      content: 10,
      technical: 10,
    },
    evidence: [
      {
        claim: "Homepage fetched.",
        sourceUrl: "https://acme.example/",
        sourceType: "homepage",
        sourceIds: ["S3"],
        confidence: "high",
      },
    ],
  };
  const recommendation: Recommendation = {
    title: "Improve contact flow",
    why: "Observed contact gap.",
    action: "Add a contact form.",
    evidence: "Homepage audit found one contact action.",
    sourceIds: ["S3"],
    priority: "medium",
  };
  return {
    schemaVersion: 2,
    provenance: {
      policy: "real-only",
      containsSyntheticData: false,
      sources: [
        {
          id: "S1",
          kind: "user_input",
          provider: "User submission",
          title: "Analysis request",
          businessName: "Acme",
          accessedAt: "2026-07-19T10:00:00.000Z",
          status: "used",
        },
        {
          id: "S2",
          kind: "nominatim",
          provider: "OpenStreetMap Nominatim",
          title: "Austin, Texas",
          url: "https://nominatim.openstreetmap.org/search?q=Austin",
          accessedAt: "2026-07-19T10:00:00.000Z",
          status: "used",
        },
        {
          id: "S3",
          kind: "homepage",
          provider: "Public business website",
          title: "Acme homepage",
          url: "https://acme.example/",
          businessName: "Acme",
          accessedAt: "2026-07-19T10:00:00.000Z",
          status: "used",
        },
      ],
    },
    input: {
      businessName: "Acme",
      businessUrl: "https://acme.example/",
      businessType: "plumber",
      market: "Austin, TX",
    },
    market: {
      label: "Austin, Texas",
      lat: 30.2672,
      lon: -97.7431,
      source: "nominatim",
      sourceIds: ["S2"],
    },
    user: {
      id: "user",
      name: "Acme",
      website: "https://acme.example/",
      source: "user",
      sourceIds: ["S1", "S3"],
      auditStatus: "complete",
      categoryMatchScore: 100,
      localPresenceScore: 50,
      websiteAudit: audit,
      signals: {
        auditStatus: "complete",
        newsStatus: "complete",
        sourceIds: ["S3"],
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
      },
      finalScore: 55,
      rank: 1,
    },
    competitors: [],
    summary: {
      competitorCount: 0,
      auditedCompetitorCount: 0,
      competitorAverageWebsiteScore: null,
      competitorAverageFinalScore: null,
      yourRank: 1,
      marketGap: null,
      status: "behind but recoverable",
    },
    report: {
      title: "Benchmark report",
      executiveSummary: "Observed results.",
      positionStatement: "Ranked on observed data.",
      topFindings: [
        {
          title: "Observed website",
          finding: "The homepage was available.",
          evidence: "HTTP fetch succeeded.",
          implication: "The website can be scored.",
          sourceIds: ["S3"],
          confidence: "high",
        },
      ],
      topRisks: [],
      competitorHighlights: [],
      actionPlan: [recommendation],
      methodologyNote: "Observed public data only.",
      dataQualityNote: "Partial comparison coverage.",
    },
    recommendations: [recommendation],
    dataQuality: {
      coverageStatus: "complete",
      realCompetitorsFound: 0,
      scoredCompetitors: 0,
      failedAudits: 0,
      limitedAudits: 0,
      unavailableFields: [
        "summary.competitorAverageWebsiteScore",
        "summary.competitorAverageFinalScore",
      ],
      cacheHit: false,
      notes: [],
    },
    generatedAt: "2026-07-19T10:00:00.000Z",
  };
}

function cloneResponse(): AnalyzeMarketResponse {
  return JSON.parse(JSON.stringify(minimalResponse())) as AnalyzeMarketResponse;
}

describe("assertRealDataResponse", () => {
  it("accepts a fully linked schema-v2 response", () => {
    expect(() => assertRealDataResponse(minimalResponse())).not.toThrow();
  });

  it("fails closed on unresolved IDs in highlights and action-plan items", () => {
    const highlightResponse = cloneResponse();
    highlightResponse.report.competitorHighlights.push({
      competitorName: "Rival",
      conciseSummary: "Observed rival.",
      sourceIds: ["S999"],
      confidence: "high",
    });
    expect(() => assertRealDataResponse(highlightResponse)).toThrow(
      /unresolved source ID S999/
    );

    const actionResponse = cloneResponse();
    actionResponse.report.actionPlan[0].sourceIds = ["S999"];
    expect(() => assertRealDataResponse(actionResponse)).toThrow(
      /unresolved source ID S999/
    );
  });

  it("rejects missing record provenance and forbidden synthetic source values", () => {
    const missing = cloneResponse();
    missing.user.signals.sourceIds = [];
    expect(() => assertRealDataResponse(missing)).toThrow(/signal scan user has no sourceIds/);

    const forbidden = cloneResponse();
    (forbidden.user as { source: string }).source = "demo";
    expect(() => assertRealDataResponse(forbidden)).toThrow(
      /forbidden synthetic source value/
    );
  });

  it("rejects legacy switches and modeled uplift fields anywhere in a v2 envelope", () => {
    const legacy = cloneResponse() as AnalyzeMarketResponse & {
      demoMode?: string;
      modeledUplift?: number;
    };
    legacy.demoMode = "mock";
    expect(() => assertRealDataResponse(legacy)).toThrow(/forbidden legacy or modeled field/);

    const modeled = cloneResponse() as AnalyzeMarketResponse & {
      modeledUplift?: number;
    };
    modeled.modeledUplift = 12;
    expect(() => assertRealDataResponse(modeled)).toThrow(/forbidden legacy or modeled field/);
  });

  it("rejects unavailable audits with zero-filled metrics and scored records without ranks", () => {
    const zeroFilled = cloneResponse();
    zeroFilled.user.auditStatus = "unavailable";
    zeroFilled.user.websiteAudit.auditStatus = "unavailable";
    zeroFilled.user.signals.auditStatus = "unavailable";
    expect(() => assertRealDataResponse(zeroFilled)).toThrow(/must be null when unavailable/);

    const unranked = cloneResponse();
    unranked.user.rank = null;
    unranked.summary.yourRank = null;
    expect(() => assertRealDataResponse(unranked)).toThrow(/positive observed rank/);
  });

  it("rejects summary and data-quality counts that do not match real records", () => {
    const response = cloneResponse();
    response.dataQuality.scoredCompetitors = 1;
    expect(() => assertRealDataResponse(response)).toThrow(
      /dataQuality competitor coverage/
    );
  });

  it("validates kind, timestamp, status, URL requirements, and canonical URL dedupe", () => {
    const invalidKind = cloneResponse();
    (invalidKind.provenance.sources[0] as { kind: string }).kind = "other";
    expect(() => assertRealDataResponse(invalidKind)).toThrow(/invalid kind/);

    const invalidTimestamp = cloneResponse();
    invalidTimestamp.provenance.sources[0].accessedAt = "not-a-date";
    expect(() => assertRealDataResponse(invalidTimestamp)).toThrow(
      /invalid accessedAt/
    );

    const invalidStatus = cloneResponse();
    (invalidStatus.provenance.sources[0] as { status: string }).status = "unknown";
    expect(() => assertRealDataResponse(invalidStatus)).toThrow(/invalid status/);

    const missingUrl = cloneResponse();
    delete missingUrl.provenance.sources[2].url;
    expect(() => assertRealDataResponse(missingUrl)).toThrow(/requires a URL/);

    const duplicateUrl = cloneResponse();
    duplicateUrl.provenance.sources.push({
      id: "S4",
      kind: "linked_page",
      provider: "Public business website",
      title: "Duplicate URL",
      url: "https://ACME.example/#section",
      accessedAt: "2026-07-19T10:00:00.000Z",
      status: "used",
    });
    expect(() => assertRealDataResponse(duplicateUrl)).toThrow(
      /duplicates a canonical provenance URL/
    );
  });

  it("uses the dedicated invariant error type", () => {
    const response = cloneResponse();
    response.provenance.sources = [];
    expect(() => assertRealDataResponse(response)).toThrow(
      RealDataInvariantError
    );
  });
});
