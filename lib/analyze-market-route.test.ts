import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalyzeMarketResponse } from "./types";

const mocks = vi.hoisted(() => ({
  analyzeMarket: vi.fn(),
  readCachedAnalysis: vi.fn(),
  enforceGuard: vi.fn(),
  enforceSameSiteJsonPost: vi.fn(),
  enforceGlobalAnalyzeLimit: vi.fn(),
  saveReport: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/analyze-market", () => ({
  analyzeMarket: mocks.analyzeMarket,
  readCachedAnalysis: mocks.readCachedAnalysis,
}));
vi.mock("@/lib/api-guard", () => ({
  enforceGuard: mocks.enforceGuard,
  enforceSameSiteJsonPost: mocks.enforceSameSiteJsonPost,
  enforceGlobalAnalyzeLimit: mocks.enforceGlobalAnalyzeLimit,
}));
vi.mock("@/lib/store", () => ({ saveReport: mocks.saveReport }));
vi.mock("@/lib/logger", () => ({
  logger: mocks.logger,
  serializeError: (error: unknown) => ({ message: String(error) }),
  withRequestId: (_id: string, callback: () => unknown) => callback(),
}));

import { POST } from "@/app/api/analyze-market/route";
import {
  AmbiguousMarketError,
  AnalysisTimeoutError,
  IndustryNotResolvedError,
  InsufficientRealDataError,
  MarketNotFoundError,
  NoCompetitorsFoundError,
  SourceUnavailableError,
  UserSiteUnavailableError,
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
      // 0.6 * 50 + 0.2 * 50 + 0.15 * 0 + 0.05 * (100 - 0)
      finalScore: 45,
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
    mocks.enforceSameSiteJsonPost.mockReturnValue({ ok: true });
    mocks.readCachedAnalysis.mockResolvedValue(null);
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
    [new IndustryNotResolvedError("widgetry"), 422, "INDUSTRY_NOT_RESOLVED"],
    [new NoCompetitorsFoundError("escape room", "Alameda", 3), 422, "NO_COMPETITORS_FOUND"],
    [new AnalysisTimeoutError(), 504, "ANALYSIS_TIMEOUT"],
    [new Error("socket hang up at 10.0.0.1"), 500, "INTERNAL_ERROR"],
  ])("maps pipeline errors to the error contract", async (error, status, code) => {
    mocks.analyzeMarket.mockRejectedValue(error);
    const response = await POST(request(validRequest()));
    expect(response.status).toBe(status);
    const body = await response.json();
    expect(body).toMatchObject({ code, error: expect.any(String) });
    expect(body.error).not.toContain("10.0.0.1");
    expect(mocks.saveReport).not.toHaveBeenCalled();
    if (status < 500) expect(mocks.logger.error).not.toHaveBeenCalled();
    else expect(mocks.logger.error).toHaveBeenCalled();
  });

  it("returns ambiguous-market candidates and the user-site reason", async () => {
    mocks.analyzeMarket.mockRejectedValueOnce(
      new AmbiguousMarketError("Springfield, US", ["Springfield, IL", "Springfield, MO"])
    );
    const ambiguous = await POST(request(validRequest()));
    expect(ambiguous.status).toBe(422);
    expect(await ambiguous.json()).toMatchObject({
      code: "AMBIGUOUS_MARKET",
      candidates: ["Springfield, IL", "Springfield, MO"],
    });

    mocks.analyzeMarket.mockRejectedValueOnce(
      new UserSiteUnavailableError("blocked_by_site", "Your website refused our check.")
    );
    const blocked = await POST(request(validRequest()));
    expect(blocked.status).toBe(422);
    expect(await blocked.json()).toMatchObject({
      code: "USER_SITE_UNAVAILABLE",
      reason: "blocked_by_site",
      retryable: true,
    });
    expect(blocked.headers.get("Retry-After")).toBe("60");

    mocks.analyzeMarket.mockRejectedValueOnce(
      new UserSiteUnavailableError("dns_unresolved", "Your website's domain does not resolve.")
    );
    const dead = await POST(request(validRequest()));
    expect(await dead.json()).toMatchObject({
      code: "USER_SITE_UNAVAILABLE",
      reason: "dns_unresolved",
      retryable: false,
    });
    expect(dead.headers.get("Retry-After")).toBeNull();
    expect(mocks.saveReport).not.toHaveBeenCalled();
  });

  it("passes the request's abort signal into the pipeline", async () => {
    const req = request(validRequest());
    await POST(req);
    expect(mocks.analyzeMarket).toHaveBeenCalledWith(
      expect.objectContaining({ businessName: "Real Business" }),
      { signal: req.signal }
    );
  });

  it("applies the same-site JSON check and the analyze bucket before parsing", async () => {
    mocks.enforceSameSiteJsonPost.mockReturnValue({
      ok: false,
      status: 415,
      code: "UNSUPPORTED_MEDIA_TYPE",
      error: "Requests must be sent as JSON.",
    });
    const rejected = await POST(request(validRequest()));
    expect(rejected.status).toBe(415);
    expect(await rejected.json()).toEqual({
      code: "UNSUPPORTED_MEDIA_TYPE",
      error: "Requests must be sent as JSON.",
    });
    expect(mocks.enforceGuard).not.toHaveBeenCalled();
    expect(mocks.analyzeMarket).not.toHaveBeenCalled();

    mocks.enforceSameSiteJsonPost.mockReturnValue({ ok: true });
    await POST(request(validRequest()));
    expect(mocks.enforceGuard).toHaveBeenCalledWith(expect.any(Request), {
      bucket: "analyze",
    });
  });

  it("reports unknown keys in the 400 details and uses no global slot", async () => {
    const response = await POST(request({ ...validRequest(), extra: "field" }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.code).toBe("INVALID_REQUEST");
    expect(body.details.formErrors.join(" ")).toMatch(/extra/);
    expect(mocks.enforceGlobalAnalyzeLimit).not.toHaveBeenCalled();
  });

  it("serves a cached analysis without using a global analysis slot", async () => {
    const cached = validResponse();
    cached.dataQuality.cacheHit = true;
    mocks.readCachedAnalysis.mockResolvedValue(cached);
    const response = await POST(request(validRequest()));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      generatedAt: "2026-07-19T00:00:00.000Z",
      dataQuality: { cacheHit: true },
    });
    expect(mocks.enforceGlobalAnalyzeLimit).not.toHaveBeenCalled();
    expect(mocks.analyzeMarket).not.toHaveBeenCalled();
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
