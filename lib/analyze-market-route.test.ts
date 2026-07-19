import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalyzeMarketResponse } from "./types";

const mocks = vi.hoisted(() => ({
  analyzeMarket: vi.fn(),
  enforceGuard: vi.fn(),
  enforceGlobalAnalyzeLimit: vi.fn(),
  saveReport: vi.fn(),
}));

vi.mock("@/lib/analyze-market", () => ({ analyzeMarket: mocks.analyzeMarket }));
vi.mock("@/lib/api-guard", () => ({
  enforceGuard: mocks.enforceGuard,
  enforceGlobalAnalyzeLimit: mocks.enforceGlobalAnalyzeLimit,
}));
vi.mock("@/lib/store", () => ({ saveReport: mocks.saveReport }));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  serializeError: (error: unknown) => ({ message: String(error) }),
  withRequestId: (_id: string, callback: () => unknown) => callback(),
}));

import { POST } from "@/app/api/analyze-market/route";
import {
  InsufficientRealDataError,
  MarketNotFoundError,
  SourceUnavailableError,
} from "./pipeline-errors";

function request(body: unknown) {
  return new Request("http://localhost/api/analyze-market", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function validRequest() {
  return {
    businessName: "Real Business",
    businessUrl: "https://real-business.test/",
    businessType: "bakery",
    market: "Alameda, CA",
  };
}

function validResponse(): AnalyzeMarketResponse {
  const websiteAudit = {
    auditStatus: "complete" as const,
    skipped: false,
    sourceIds: ["S1" as const],
    h1Count: 1,
    headingCount: 3,
    wordCount: 250,
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
    htmlBytes: 10_000,
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
    evidence: [],
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
          provider: "User input",
          title: "Real Business input",
          url: "https://real-business.test/",
          businessName: "Real Business",
          accessedAt: "2026-07-19T00:00:00.000Z",
          status: "used",
        },
        {
          id: "S2",
          kind: "nominatim",
          provider: "Nominatim",
          title: "Alameda, CA geocode",
          accessedAt: "2026-07-19T00:00:00.000Z",
          status: "used",
        },
      ],
    },
    input: validRequest(),
    market: {
      label: "Alameda, California",
      lat: 37.7652,
      lon: -122.2416,
      source: "nominatim",
      sourceIds: ["S2"],
    },
    user: {
      id: "user",
      name: "Real Business",
      website: "https://real-business.test/",
      source: "user",
      sourceIds: ["S1"],
      auditStatus: "complete",
      categoryMatchScore: 100,
      localPresenceScore: 50,
      websiteAudit,
      signals: {
        auditStatus: "complete",
        newsStatus: "not_requested",
        sourceIds: ["S1"],
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
      title: "Real report",
      executiveSummary: "Only observed data is included.",
      positionStatement: "Insufficient ranking evidence.",
      topFindings: [],
      topRisks: [],
      competitorHighlights: [],
      actionPlan: [],
      methodologyNote: "Real public sources only.",
      dataQualityNote: "Some evidence was unavailable.",
    },
    recommendations: [],
    dataQuality: {
      coverageStatus: "partial",
      realCompetitorsFound: 0,
      scoredCompetitors: 0,
      failedAudits: 0,
      limitedAudits: 0,
      unavailableFields: [
        "summary.competitorAverageWebsiteScore",
        "summary.competitorAverageFinalScore",
        "summary.strongestCompetitor",
        "summary.marketGap",
      ],
      cacheHit: false,
      notes: [],
    },
    generatedAt: "2026-07-19T00:00:00.000Z",
  };
}

describe("POST /api/analyze-market", () => {
  beforeEach(() => {
    delete process.env.MAINTENANCE_MODE;
    vi.clearAllMocks();
    mocks.enforceGuard.mockResolvedValue({ ok: true });
    mocks.enforceGlobalAnalyzeLimit.mockResolvedValue({ ok: true });
    mocks.analyzeMarket.mockResolvedValue(validResponse());
    mocks.saveReport.mockResolvedValue("report123");
  });

  afterEach(() => {
    delete process.env.MAINTENANCE_MODE;
  });

  it("returns only a validated, persisted v2 report", async () => {
    const response = await POST(request(validRequest()));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      schemaVersion: 2,
      reportId: "report123",
      provenance: { policy: "real-only", containsSyntheticData: false },
    });
    expect(mocks.saveReport).toHaveBeenCalledOnce();
  });

  it("rejects the removed demoMode option", async () => {
    const response = await POST(request({ ...validRequest(), options: { demoMode: "mock" } }));
    expect(response.status).toBe(400);
    expect(mocks.analyzeMarket).not.toHaveBeenCalled();
  });

  it.each([
    [new MarketNotFoundError("Nowhere"), 422, "MARKET_NOT_FOUND"],
    [new SourceUnavailableError("overpass", "Unavailable"), 503, "SOURCE_UNAVAILABLE"],
    [new InsufficientRealDataError(), 422, "INSUFFICIENT_REAL_DATA"],
  ])("maps typed pipeline errors", async (error, status, code) => {
    mocks.analyzeMarket.mockRejectedValue(error);
    const response = await POST(request(validRequest()));
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ code });
    expect(mocks.saveReport).not.toHaveBeenCalled();
  });

  it("returns 503 instead of an unpersisted success", async () => {
    mocks.saveReport.mockRejectedValue(new Error("store down"));
    const response = await POST(request(validRequest()));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "SOURCE_UNAVAILABLE" });
  });

  it("does not save or return a report that violates provenance", async () => {
    const invalid = validResponse();
    Object.assign(invalid.provenance, { containsSyntheticData: true });
    mocks.analyzeMarket.mockResolvedValue(invalid);
    const response = await POST(request(validRequest()));
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ code: "REAL_DATA_INVARIANT_FAILED" });
    expect(mocks.saveReport).not.toHaveBeenCalled();
  });

  it("keeps monitoring-compatible maintenance containment", async () => {
    process.env.MAINTENANCE_MODE = "true";
    const response = await POST(request(validRequest()));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "MAINTENANCE" });
    expect(mocks.enforceGuard).not.toHaveBeenCalled();
  });
});
