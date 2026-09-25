// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type {
  AnalyzeMarketResponse,
  CompetitorReport,
  Recommendation,
  WebsiteAudit,
} from "@/lib/types";
import ResultsDashboard from "./ResultsDashboard";

function audit(
  overrides: Partial<WebsiteAudit> = {}
): WebsiteAudit {
  return {
    auditStatus: "complete",
    skipped: false,
    sourceIds: ["S3"],
    h1Count: 1,
    headingCount: 4,
    wordCount: 420,
    ctaCount: 2,
    hasPhone: true,
    hasEmail: true,
    hasContactPage: true,
    hasBookingOrQuote: true,
    hasPricingPage: false,
    hasServicesPage: true,
    hasAboutOrTeamPage: true,
    hasBlogOrNewsPage: false,
    hasCareersPage: false,
    hasTestimonials: true,
    hasTrustLanguage: true,
    hasGalleryOrCaseStudy: false,
    hasSocialLinks: false,
    hasViewport: true,
    isHttps: true,
    htmlBytes: 42_000,
    fetchMs: 220,
    extractedLinks: [],
    socialLinks: {},
    websiteScore: 68,
    scoreBreakdown: {
      seo: 18,
      conversion: 17,
      trust: 13,
      content: 12,
      technical: 8,
    },
    evidence: [],
    ...overrides,
  };
}

function competitor(
  overrides: Partial<CompetitorReport> = {}
): CompetitorReport {
  return {
    id: "verify-dental",
    name: "Verify Dental",
    website: "https://verify-dental.example.org",
    source: "user",
    sourceIds: ["S1", "S3"],
    auditStatus: "complete",
    categoryMatchScore: 100,
    localPresenceScore: 70,
    websiteAudit: audit(),
    signals: {
      auditStatus: "complete",
      newsStatus: "not_requested",
      sourceIds: ["S3"],
      socialLinks: {},
      momentumSignals: [
        {
          label: "New patient offer",
          evidence: "Homepage advertises a new-patient promotion.",
          sourceUrl: "https://verify-dental.example.org",
          sourceType: "homepage",
          sourceIds: ["S3"],
          confidence: "high",
        },
      ],
      riskSignals: [],
      changeSignals: [],
      offerSignals: [],
      hiringSignals: [],
      newsSignals: [],
      momentumScore: 15,
      riskScore: 0,
      changeScore: 0,
    },
    finalScore: 64,
    rank: 1,
    ...overrides,
  };
}

function buildResponse(): AnalyzeMarketResponse {
  const user = competitor();
  const unaudited = competitor({
    id: "rival-unavailable",
    name: "Rival Dental (discovered only)",
    website: undefined,
    source: "overpass",
    sourceIds: ["S2"],
    auditStatus: "unavailable",
    categoryMatchScore: null,
    localPresenceScore: null,
    websiteAudit: audit({
      auditStatus: "unavailable",
      skipped: true,
      reason: "No public website was discoverable.",
      sourceIds: ["S2"],
      h1Count: null,
      headingCount: null,
      wordCount: null,
      ctaCount: null,
      hasPhone: null,
      hasEmail: null,
      hasContactPage: null,
      hasBookingOrQuote: null,
      hasPricingPage: null,
      hasServicesPage: null,
      hasAboutOrTeamPage: null,
      hasBlogOrNewsPage: null,
      hasCareersPage: null,
      hasTestimonials: null,
      hasTrustLanguage: null,
      hasGalleryOrCaseStudy: null,
      hasSocialLinks: null,
      hasViewport: null,
      isHttps: null,
      htmlBytes: null,
      fetchMs: null,
      websiteScore: null,
      scoreBreakdown: {
        seo: null,
        conversion: null,
        trust: null,
        content: null,
        technical: null,
      },
    }),
    signals: {
      auditStatus: "unavailable",
      newsStatus: "not_requested",
      sourceIds: ["S2"],
      socialLinks: {},
      momentumSignals: [],
      riskSignals: [],
      changeSignals: [],
      offerSignals: [],
      hiringSignals: [],
      newsSignals: [],
      momentumScore: null,
      riskScore: null,
      changeScore: null,
    },
    finalScore: null,
    rank: null,
  });

  const recommendation: Recommendation = {
    title: "Strengthen service detail",
    why: "The audited homepage has limited service detail.",
    action: "Publish a service page.",
    evidence: "Homepage audit.",
    sourceIds: ["S3"],
    priority: "high",
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
          provider: "Submitted request",
          title: "Verify Dental request",
          businessName: "Verify Dental",
          accessedAt: "2026-07-19T08:00:00.000Z",
          status: "used",
        },
        {
          id: "S2",
          kind: "openstreetmap",
          provider: "OpenStreetMap",
          title: "Austin dentist discovery",
          url: "https://overpass-api.de/api/interpreter",
          accessedAt: "2026-07-19T08:00:01.000Z",
          status: "used",
        },
        {
          id: "S3",
          kind: "homepage",
          provider: "Public website",
          title: "Verify Dental homepage",
          businessName: "Verify Dental",
          url: "https://verify-dental.example.org/",
          accessedAt: "2026-07-19T08:00:02.000Z",
          status: "used",
        },
      ],
    },
    input: {
      businessName: "Verify Dental",
      businessUrl: "https://verify-dental.example.org",
      businessType: "dentist",
      market: "Austin, TX",
    },
    market: {
      label: "Austin, TX",
      lat: 30.2672,
      lon: -97.7431,
      source: "nominatim",
      sourceIds: ["S2"],
    },
    user,
    competitors: [unaudited],
    summary: {
      competitorCount: 1,
      auditedCompetitorCount: 0,
      competitorAverageWebsiteScore: null,
      competitorAverageFinalScore: null,
      yourRank: null,
      marketGap: null,
      status: null,
    },
    report: {
      title: "Benchmark Scout Report — Verify Dental (Austin, TX)",
      executiveSummary: "A real-data-only benchmark with limited comparison evidence.",
      positionStatement: "A verified score is available only for the submitted business.",
      topFindings: [
        {
          title: "Homepage offer",
          finding: "A new-patient offer is visible.",
          evidence: "Homepage content.",
          implication: "Keep it current.",
          sourceIds: ["S3"],
          confidence: "high",
        },
      ],
      topRisks: [
        {
          title: "Comparison coverage",
          finding: "The discovered competitor could not be audited.",
          evidence: "Discovery and website lookup.",
          implication: "Do not infer a competitor score.",
          sourceIds: ["S2"],
          confidence: "high",
        },
      ],
      competitorHighlights: [],
      actionPlan: [recommendation],
      methodologyNote: "Real public sources only.",
      dataQualityNote: "One discovered competitor remained unaudited.",
    },
    recommendations: [recommendation],
    dataQuality: {
      coverageStatus: "partial",
      realCompetitorsFound: 1,
      scoredCompetitors: 0,
      failedAudits: 0,
      limitedAudits: 1,
      unavailableFields: ["competitors[0].finalScore"],
      cacheHit: false,
      notes: ["One discovered competitor remained unaudited."],
    },
    generatedAt: "2026-07-19T08:00:03.000Z",
  };
}

describe("ResultsDashboard", () => {
  it("keeps discovered unaudited competitors visible and renders unavailable metrics as N/A", () => {
    render(<ResultsDashboard data={buildResponse()} />);

    expect(screen.getByText("Rival Dental (discovered only)")).toBeInTheDocument();
    expect(
      screen.getByText("Discovered; no website listed")
    ).toBeInTheDocument();
    expect(screen.getAllByText("N/A").length).toBeGreaterThan(4);
  });

  it("renders citation markers and the complete embedded sources appendix", () => {
    render(<ResultsDashboard data={buildResponse()} />);

    expect(screen.getByText("Sources Appendix")).toBeInTheDocument();
    expect(screen.getAllByLabelText("Sources S3").length).toBeGreaterThan(0);
    expect(screen.getAllByLabelText("Sources S2").length).toBeGreaterThan(0);
    expect(screen.getByText("Verify Dental request")).toBeInTheDocument();
    expect(screen.getByText("Austin dentist discovery")).toBeInTheDocument();
    expect(screen.getByText("Verify Dental homepage")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "verify-dental.example.org" })
    ).toHaveAttribute("href", "https://verify-dental.example.org/");
    // The Overpass endpoint is queried by POST, so it is not rendered as a
    // dead link.
    expect(
      screen.getByText(/Overpass query sent as a POST request; no direct link/)
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: /overpass-api\.de/ })
    ).not.toBeInTheDocument();
  });

  it("shows the OpenStreetMap attribution wherever OSM competitors are listed", () => {
    render(<ResultsDashboard data={buildResponse()} />);

    const links = screen.getAllByRole("link", {
      name: "Map data © OpenStreetMap contributors",
    });
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link).toHaveAttribute(
        "href",
        "https://www.openstreetmap.org/copyright"
      );
    }
  });

  it("renders per-category scores with the audit evidence behind them", () => {
    render(<ResultsDashboard data={buildResponse()} />);

    expect(screen.getByText("Website score by category")).toBeInTheDocument();
    expect(screen.getByText("18/25")).toBeInTheDocument();
    expect(screen.getByText("a linked services page")).toBeInTheDocument();
    expect(screen.getAllByText("Not found:").length).toBeGreaterThan(0);
  });

  it("shows the report's age and an explicit empty action-plan statement", () => {
    const data = buildResponse();
    data.recommendations = [];
    data.report.actionPlan = [];
    data.report.actionPlanNote =
      "No material gaps found: your homepage audit showed every element this report checks.";
    render(
      <ResultsDashboard
        data={data}
        sampleFreshness="retained"
        now={Date.parse("2026-07-24T09:00:00.000Z")}
      />
    );

    expect(screen.getAllByText(/5 days ago/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/just older than 72 hours/)).not.toBeInTheDocument();
    expect(screen.getAllByText(/^No material gaps found/)).toHaveLength(2);
  });

  it("puts the market-position finding in the on-screen top three", () => {
    const data = buildResponse();
    const category = data.report.topFindings[0];
    data.report.topFindings = [
      { ...category, title: "SEO gap" },
      { ...category, title: "Trust gap" },
      { ...category, title: "Content gap" },
      { ...category, title: "Observed market position" },
    ];
    render(<ResultsDashboard data={data} />);

    expect(screen.getByText("Observed market position:")).toBeInTheDocument();
    expect(screen.queryByText("Content gap:")).not.toBeInTheDocument();
  });

  it("describes the report as real-only and never claims fallback data", () => {
    render(<ResultsDashboard data={buildResponse()} />);

    expect(screen.getByText(/real public data/i)).toBeInTheDocument();
    expect(screen.queryByText(/fallback demo/i)).not.toBeInTheDocument();
  });
});
