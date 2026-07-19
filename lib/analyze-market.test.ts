import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditResult } from "./audit";
import type { AuditStatus, SourceId, WebsiteAudit } from "./types";

vi.mock("./cache", () => ({
  readCache: vi.fn(async () => null),
  writeCache: vi.fn(async () => {}),
  writeNamedFile: vi.fn(async () => {}),
}));
vi.mock("./geocode", () => ({
  geocodeMarket: vi.fn(async () => ({
    label: "Austin, Travis County, Texas, USA",
    lat: 30.2672,
    lon: -97.7431,
    source: "nominatim",
    accessedAt: "2026-07-19T10:00:00.000Z",
  })),
}));
vi.mock("./discover", () => ({
  discoverCompetitors: vi.fn(),
}));
vi.mock("./gdelt", () => ({
  fetchNewsSignals: vi.fn(async (businessName: string) => ({
    status: "complete",
    signals: [],
    queryUrl: `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(businessName)}`,
    accessedAt: "2026-07-19T10:00:00.000Z",
  })),
}));
vi.mock("./audit", () => ({
  auditWebsite: vi.fn(),
  skippedAudit: vi.fn(),
}));

import {
  ANALYSIS_TIMING_BUDGETS,
  analyzeMarket,
  analysisCacheKey,
} from "./analyze-market";
import { auditWebsite, skippedAudit } from "./audit";
import { readCache, writeCache, writeNamedFile } from "./cache";
import { discoverCompetitors } from "./discover";
import { assertRealDataResponse } from "./invariants";
import { InsufficientRealDataError } from "./pipeline-errors";

const input = {
  businessName: "Acme Dental",
  businessUrl: "https://acme.example/",
  businessType: "dentist",
  market: "Austin, TX",
};

function unavailableAudit(
  url: string | undefined,
  sourceIds: SourceId[] = []
): AuditResult {
  const audit: WebsiteAudit = {
    url,
    auditStatus: "unavailable",
    skipped: true,
    reason: url ? "homepage fetch failed" : "no public website listed",
    sourceIds,
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
    extractedLinks: [],
    socialLinks: {},
    websiteScore: null,
    scoreBreakdown: {
      seo: null,
      conversion: null,
      trust: null,
      content: null,
      technical: null,
    },
    evidence: sourceIds.length
      ? [
          {
            claim: "Website audit unavailable.",
            sourceUrl: url,
            sourceType: "homepage",
            sourceIds,
            confidence: "low",
          },
        ]
      : [],
  };
  return {
    audit,
    pageTexts: [],
    linkedPageAttempts: [],
    accessedAt: "2026-07-19T10:00:00.000Z",
  };
}

function observedAudit(
  url: string,
  sourceId: SourceId,
  status: AuditStatus = "complete"
): AuditResult {
  const audit: WebsiteAudit = {
    url,
    normalizedUrl: url,
    auditStatus: status,
    skipped: false,
    sourceIds: [sourceId],
    title: "Observed business homepage",
    metaDescription: "Local dental care",
    h1Count: 1,
    headingCount: 3,
    wordCount: 420,
    ctaCount: 2,
    hasPhone: true,
    hasEmail: false,
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
    htmlBytes: 10_000,
    fetchMs: 100,
    extractedLinks: [],
    socialLinks: {},
    websiteScore: 71,
    scoreBreakdown: {
      seo: 20,
      conversion: 20,
      trust: 15,
      content: 10,
      technical: 6,
    },
    evidence: [
      {
        claim: "Homepage fetched successfully.",
        sourceUrl: url,
        sourceType: "homepage",
        sourceIds: [sourceId],
        confidence: "high",
      },
    ],
  };
  return {
    audit,
    accessedAt: "2026-07-19T10:00:00.000Z",
    linkedPageAttempts: [],
    pageTexts: [
      {
        url,
        text: "Trusted local dental care. Book an appointment.",
        sourceType: "homepage",
        sourceIds: [sourceId],
      },
    ],
  };
}

describe("analyzeMarket real-data-only orchestration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readCache).mockResolvedValue(null);
    vi.mocked(discoverCompetitors).mockResolvedValue({
      discoverySource: "overpass",
      status: "complete",
      queryPerformed: true,
      endpoint: "https://overpass.kumi.systems/api/interpreter",
      accessedAt: "2026-07-19T09:59:00.000Z",
      candidates: [
        {
          id: "osm-node-1",
          osmElementUrl: "https://www.openstreetmap.org/node/1",
          name: "Rival Dental",
          website: "https://rival.example/",
          phone: "555-0100",
          address: "1 Main St",
          lat: 30.2,
          lon: -97.7,
          source: "overpass",
          priorityScore: 90,
        },
        {
          id: "osm-node-2",
          osmElementUrl: "https://www.openstreetmap.org/node/2",
          name: "Directory Only Dental",
          address: "2 Main St",
          source: "overpass",
          priorityScore: 30,
        },
        {
          id: "osm-node-3",
          osmElementUrl: "https://www.openstreetmap.org/node/3",
          name: "Offline Dental",
          website: "https://offline.example/",
          source: "overpass",
          priorityScore: 20,
        },
      ],
    });
    vi.mocked(skippedAudit).mockImplementation((url, _reason, sourceIds = []) =>
      unavailableAudit(url, sourceIds)
    );
    vi.mocked(auditWebsite).mockImplementation(async ({ url, sourceId }) =>
      url.includes("offline")
        ? unavailableAudit(url, [sourceId])
        : observedAudit(url, sourceId)
    );
  });

  it("returns schema v2 with resolved real provenance and leaves unaudited rows unranked", async () => {
    const response = await analyzeMarket(input);

    expect(response.schemaVersion).toBe(2);
    expect(response.provenance).toMatchObject({
      policy: "real-only",
      containsSyntheticData: false,
    });
    expect(response.market.source).toBe("nominatim");
    expect(
      response.provenance.sources.find(
        (source) => source.provider === "OpenStreetMap Overpass"
      )
    ).toMatchObject({
      url: "https://overpass.kumi.systems/api/interpreter",
      accessedAt: "2026-07-19T09:59:00.000Z",
      status: "used",
    });
    expect(response.competitors).toHaveLength(3);
    expect(response.competitors.every((item) => item.source === "overpass")).toBe(
      true
    );
    const rivalMapSource = response.provenance.sources.find(
      (source) => source.url === "https://www.openstreetmap.org/node/1"
    );
    expect(rivalMapSource).toMatchObject({
      kind: "openstreetmap",
      businessName: "Rival Dental",
      status: "used",
    });
    expect(response.competitors[0].sourceIds).toContain(rivalMapSource!.id);
    expect(
      response.provenance.sources.find(
        (source) => source.url === input.businessUrl
      )?.accessedAt
    ).toBe("2026-07-19T10:00:00.000Z");
    const unscored = response.competitors.filter(
      (competitor) => competitor.auditStatus === "unavailable"
    );
    expect(unscored).toHaveLength(2);
    expect(unscored.every((competitor) => competitor.rank === null)).toBe(true);
    expect(unscored.every((competitor) => competitor.finalScore === null)).toBe(
      true
    );
    expect(response.dataQuality).toMatchObject({
      realCompetitorsFound: 3,
      scoredCompetitors: 1,
      failedAudits: 2,
      coverageStatus: "partial",
      cacheHit: false,
    });
    expect(JSON.stringify(response)).not.toMatch(/"(?:source|provider)":"[^"]*(?:mock|demo|synthetic)/i);
    expect(() => assertRealDataResponse(response)).not.toThrow();
    expect(writeCache).toHaveBeenCalledOnce();
    expect(writeNamedFile).toHaveBeenCalledOnce();
  });

  it("registers failed selected linked-page attempts with URL, status, timestamp, and evidence", async () => {
    vi.mocked(auditWebsite).mockImplementation(async ({ url, sourceId }) => {
      if (url.includes("offline")) return unavailableAudit(url, [sourceId]);
      const result = observedAudit(url, sourceId);
      if (url.includes("rival")) {
        result.audit.auditStatus = "partial";
        result.audit.reason = "some linked pages could not be fetched";
        result.linkedPageAttempts = [
          {
            url: "https://rival.example/services",
            status: "unavailable",
            reason: "HTTP 503",
            accessedAt: "2026-07-19T10:00:05.000Z",
          },
        ];
      }
      return result;
    });

    const response = await analyzeMarket(input);
    const linkedSource = response.provenance.sources.find(
      (source) => source.url === "https://rival.example/services"
    );
    expect(linkedSource).toMatchObject({
      kind: "linked_page",
      businessName: "Rival Dental",
      status: "unavailable",
      accessedAt: "2026-07-19T10:00:05.000Z",
    });
    const rival = response.competitors.find(
      (competitor) => competitor.name === "Rival Dental"
    )!;
    expect(rival.sourceIds).toContain(linkedSource!.id);
    expect(rival.websiteAudit.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceUrl: "https://rival.example/services",
          sourceIds: [linkedSource!.id],
        }),
      ])
    );
    expect(() => assertRealDataResponse(response)).not.toThrow();
  });

  it("fails with typed 422 and writes nothing when no audit has usable evidence", async () => {
    vi.mocked(discoverCompetitors).mockResolvedValue({
      discoverySource: "overpass",
      status: "complete",
      queryPerformed: true,
      endpoint: "https://overpass-api.de/api/interpreter",
      accessedAt: "2026-07-19T09:59:00.000Z",
      candidates: [],
    });
    vi.mocked(auditWebsite).mockImplementation(async ({ url, sourceId }) =>
      unavailableAudit(url, [sourceId])
    );

    const pending = analyzeMarket(input);
    await expect(pending).rejects.toBeInstanceOf(InsufficientRealDataError);
    await expect(pending).rejects.toMatchObject({
      code: "INSUFFICIENT_REAL_DATA",
      status: 422,
    });
    expect(writeCache).not.toHaveBeenCalled();
    expect(writeNamedFile).not.toHaveBeenCalled();
  });

  it("returns a partial unranked report when real OSM records exist but all audits fail", async () => {
    vi.mocked(auditWebsite).mockImplementation(async ({ url, sourceId }) =>
      unavailableAudit(url, [sourceId])
    );

    const response = await analyzeMarket(input);

    expect(response.dataQuality.coverageStatus).toBe("partial");
    expect(response.dataQuality.realCompetitorsFound).toBe(3);
    expect(response.dataQuality.scoredCompetitors).toBe(0);
    expect(response.user.rank).toBeNull();
    expect(response.summary).toMatchObject({
      auditedCompetitorCount: 0,
      competitorAverageWebsiteScore: null,
      competitorAverageFinalScore: null,
      yourRank: null,
      marketGap: null,
      status: null,
    });
    expect(response.recommendations).toEqual([]);
    expect(response.dataQuality.unavailableFields).toEqual(
      expect.arrayContaining([
        "summary.yourRank",
        "summary.marketGap",
        "summary.status",
        "summary.competitorAverageWebsiteScore",
        "summary.competitorAverageFinalScore",
        "summary.strongestCompetitor",
      ])
    );
    expect(() => assertRealDataResponse(response)).not.toThrow();
    expect(writeCache).toHaveBeenCalledOnce();
  });

  it("uses a stable input-only cache key and ignores invalid legacy cache data", async () => {
    expect(analysisCacheKey(input)).toBe(JSON.stringify(input));
    vi.mocked(readCache).mockResolvedValue({ schemaVersion: 1 } as never);

    const response = await analyzeMarket(input);

    expect(response.schemaVersion).toBe(2);
    expect(auditWebsite).toHaveBeenCalled();
    expect(writeCache).toHaveBeenCalledWith(
      "reports",
      JSON.stringify(input),
      expect.objectContaining({ schemaVersion: 2 })
    );
  });

  it("keeps the explicit worst-case network schedule below the 42s analysis ceiling", () => {
    const auditWaves = Math.ceil(11 / ANALYSIS_TIMING_BUDGETS.auditConcurrency);
    const scheduledNetworkMs =
      ANALYSIS_TIMING_BUDGETS.geocodeMs +
      ANALYSIS_TIMING_BUDGETS.overpassMs +
      auditWaves * ANALYSIS_TIMING_BUDGETS.auditPerEntityMs +
      ANALYSIS_TIMING_BUDGETS.newsPerEntityMs;

    expect(scheduledNetworkMs).toBe(35_500);
    expect(scheduledNetworkMs).toBeLessThan(
      ANALYSIS_TIMING_BUDGETS.overallMs
    );
    expect(ANALYSIS_TIMING_BUDGETS.overallMs).toBeLessThan(60_000);
  });
});
