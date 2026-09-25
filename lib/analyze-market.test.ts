import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditResult } from "./audit";
import type { DiscoveredCandidate, DiscoveryResult } from "./discover";
import type { AuditStatus, SourceId, WebsiteAudit } from "./types";

vi.mock("./cache", () => ({
  CACHE_TTL: { reports: 6 * 60 * 60 * 1000 },
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
    queryUrl:
      "https://nominatim.openstreetmap.org/search?q=Austin%2C%20TX&format=jsonv2&addressdetails=1&limit=10",
  })),
  nominatimSearchUrl: (market: string) =>
    `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(market)}`,
}));
vi.mock("./discover", () => ({
  discoverCompetitors: vi.fn(),
}));
vi.mock("./gdelt", () => ({
  fetchCombinedNewsSignals: vi.fn(
    async (entities: Array<{ id: string; name: string }>) => ({
      status: "complete",
      queryUrl: "https://api.gdeltproject.org/api/v2/doc/doc?query=combined",
      accessedAt: "2026-07-19T10:00:00.000Z",
      queried: entities.map((entity) => entity.id),
      skipped: [],
      articlesByEntity: {},
    })
  ),
}));
vi.mock("./audit", () => ({
  auditWebsite: vi.fn(),
  skippedAudit: vi.fn(),
}));

import {
  ANALYSIS_TIMING_BUDGETS,
  MAX_AUDIT_ATTEMPTS,
  MAX_AUDITED_COMPETITORS,
  analyzeMarket,
  analysisCacheKey,
} from "./analyze-market";
import { auditWebsite, skippedAudit } from "./audit";
import { readCache, writeCache, writeNamedFile } from "./cache";
import { discoverCompetitors } from "./discover";
import { fetchCombinedNewsSignals } from "./gdelt";
import { assertRealDataResponse } from "./invariants";
import { OVERPASS_ENDPOINTS, OVERPASS_FAILOVER } from "./overpass";
import {
  IndustryNotResolvedError,
  NoCompetitorsFoundError,
  UserSiteUnavailableError,
} from "./pipeline-errors";
import { validateRealReport } from "../scripts/validate-real-report.mjs";

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

function candidate(
  id: number,
  overrides: Partial<DiscoveredCandidate> = {}
): DiscoveredCandidate {
  return {
    id: `osm-node-${id}`,
    osmElementUrl: `https://www.openstreetmap.org/node/${id}`,
    name: `Rival ${id}`,
    website: `https://rival-${id}.example/`,
    lat: 30.2,
    lon: -97.7,
    source: "overpass",
    priorityScore: 50,
    distanceKm: id / 10,
    osmTags: { amenity: "dentist", name: `Rival ${id}` },
    ...overrides,
  };
}

function discovery(
  candidates: DiscoveredCandidate[],
  overrides: Partial<DiscoveryResult> = {}
): DiscoveryResult {
  return {
    discoverySource: "overpass",
    status: "complete",
    queryPerformed: true,
    endpoint: "https://overpass-api.de/api/interpreter",
    accessedAt: "2026-07-19T09:59:00.000Z",
    query: '[out:json][timeout:25];\n(\n  nwr["amenity"="dentist"]["name"](around:5000,30.2672,-97.7431);\n);\nout center tags 500;',
    radiusKm: 5,
    truncated: false,
    resolution: {
      tags: [["amenity", "dentist"]],
      stage: "map",
      matched: "dentist",
    },
    candidates,
    ...overrides,
  };
}

describe("analyzeMarket real-data-only orchestration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readCache).mockResolvedValue(null);
    vi.mocked(discoverCompetitors).mockResolvedValue(
      discovery([
        candidate(1, {
          name: "Rival Dental",
          website: "https://rival.example/",
          phone: "555-0100",
          address: "1 Main St",
          priorityScore: 90,
        }),
        candidate(2, {
          name: "Directory Only Dental",
          website: undefined,
          address: "2 Main St",
        }),
        candidate(3, {
          name: "Offline Dental",
          website: "https://offline.example/",
        }),
      ])
    );
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
    expect(response.market).toMatchObject({ source: "nominatim", radiusKm: 5 });
    const overpassSource = response.provenance.sources.find(
      (source) => source.provider === "OpenStreetMap Overpass"
    );
    // A clickable overpass-turbo link carrying the exact query, not the bare
    // API endpoint (which answers a browser GET with HTTP 406).
    expect(overpassSource).toMatchObject({
      accessedAt: "2026-07-19T09:59:00.000Z",
      status: "used",
    });
    expect(overpassSource!.url).toMatch(/^https:\/\/overpass-turbo\.eu\/\?Q=/);
    expect(decodeURIComponent(overpassSource!.url!.split("?Q=")[1])).toContain(
      'nwr["amenity"="dentist"]'
    );
    expect(
      response.provenance.sources.find((source) => source.kind === "nominatim")?.url
    ).toContain("nominatim.openstreetmap.org/search?q=Austin");
    expect(response.competitors).toHaveLength(3);
    expect(response.competitors.every((item) => item.source === "overpass")).toBe(
      true
    );
    expect(response.competitors.map((item) => item.distanceKm).sort()).toEqual([
      0.1, 0.2, 0.3,
    ]);
    const rivalMapSource = response.provenance.sources.find(
      (source) => source.url === "https://www.openstreetmap.org/node/1"
    );
    expect(rivalMapSource).toMatchObject({
      kind: "openstreetmap",
      businessName: "Rival Dental",
      status: "used",
    });
    expect(response.competitors[0].sourceIds).toContain(rivalMapSource!.id);
    // Category match comes from the element's own OSM tags.
    expect(response.competitors[0].categoryMatchScore).toBe(100);
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
      auditOutcomes: { scored: 1, noWebsite: 1, auditFailed: 1, notAttempted: 0 },
    });
    expect(response.dataQuality.notes.join(" ")).not.toMatch(/\(s\)|zero-result/);
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

  it("stops with NO_COMPETITORS_FOUND and saves nothing when a mapped category finds nobody", async () => {
    vi.mocked(discoverCompetitors).mockResolvedValue(discovery([]));

    const pending = analyzeMarket(input);
    await expect(pending).rejects.toBeInstanceOf(NoCompetitorsFoundError);
    await expect(pending).rejects.toMatchObject({
      code: "NO_COMPETITORS_FOUND",
      status: 422,
    });
    expect(auditWebsite).not.toHaveBeenCalled();
    expect(writeCache).not.toHaveBeenCalled();
    expect(writeNamedFile).not.toHaveBeenCalled();
  });

  it.each([
    [
      "probe tags found nothing",
      discovery([], {
        resolution: { tags: [["shop", "widget"]], stage: "probe", matched: "widget" },
      }),
    ],
    [
      "no tags resolved",
      discovery([], {
        queryPerformed: false,
        query: undefined,
        resolution: { tags: [], stage: "none", matched: null },
      }),
    ],
  ])("stops with INDUSTRY_NOT_RESOLVED when %s", async (_label, result) => {
    vi.mocked(discoverCompetitors).mockResolvedValue(result);
    await expect(analyzeMarket(input)).rejects.toBeInstanceOf(
      IndustryNotResolvedError
    );
    expect(writeCache).not.toHaveBeenCalled();
  });

  it("stops with USER_SITE_UNAVAILABLE and saves nothing when the user's site cannot be audited", async () => {
    vi.mocked(auditWebsite).mockImplementation(async ({ url, sourceId }) => {
      if (url !== input.businessUrl) return observedAudit(url, sourceId);
      const blocked = unavailableAudit(url, [sourceId]);
      blocked.audit.reason = "Site refused automated access";
      blocked.audit.reasonCode = "blocked_by_site";
      return blocked;
    });

    const error = await analyzeMarket(input).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(UserSiteUnavailableError);
    expect(error).toMatchObject({
      code: "USER_SITE_UNAVAILABLE",
      status: 422,
      reason: "blocked_by_site",
    });
    expect((error as Error).message).toMatch(/refused our automated check/);
    expect((error as Error).message).toMatch(/no report was saved/);
    expect(writeCache).not.toHaveBeenCalled();
    expect(writeNamedFile).not.toHaveBeenCalled();
  });

  it("returns a partial report when every competitor audit fails", async () => {
    vi.mocked(auditWebsite).mockImplementation(async ({ url, sourceId }) =>
      url === input.businessUrl
        ? observedAudit(url, sourceId)
        : unavailableAudit(url, [sourceId])
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
    expect(response.dataQuality.unavailableFields).toEqual(
      expect.arrayContaining([
        "summary.competitorAverageWebsiteScore",
        "summary.competitorAverageFinalScore",
        "summary.strongestCompetitor",
      ])
    );
    expect(() => assertRealDataResponse(response)).not.toThrow();
    expect(writeCache).toHaveBeenCalledOnce();
  });

  it("audits the nearest websites and backfills failed audits with the next-nearest", async () => {
    const candidates = Array.from({ length: 12 }, (_, index) => candidate(index + 1));
    vi.mocked(discoverCompetitors).mockResolvedValue(discovery(candidates));
    const failing = new Set(["https://rival-1.example/", "https://rival-2.example/"]);
    vi.mocked(auditWebsite).mockImplementation(async ({ url, sourceId }) =>
      failing.has(url) ? unavailableAudit(url, [sourceId]) : observedAudit(url, sourceId)
    );

    const response = await analyzeMarket(input);
    const auditedUrls = vi
      .mocked(auditWebsite)
      .mock.calls.map(([args]) => args.url)
      .filter((url) => url !== input.businessUrl);

    // 7 successes needed; the 2 failures were replaced by rivals 8 and 9.
    expect(auditedUrls).toHaveLength(MAX_AUDITED_COMPETITORS + 2);
    expect(auditedUrls.length).toBeLessThanOrEqual(MAX_AUDIT_ATTEMPTS);
    expect(new Set(auditedUrls)).toEqual(
      new Set(candidates.slice(0, 9).map((item) => item.website))
    );
    expect(response.dataQuality.scoredCompetitors).toBe(MAX_AUDITED_COMPETITORS);
    expect(response.competitors.length).toBeLessThanOrEqual(10);
    expect(() => assertRealDataResponse(response)).not.toThrow();
  });

  it("lists chain locations with isChain/brand but never audits or ranks them", async () => {
    vi.mocked(discoverCompetitors).mockResolvedValue(
      discovery([
        candidate(1, { isChain: true, brand: "Great Clips", name: "Great Clips" }),
        candidate(2),
      ])
    );

    const response = await analyzeMarket(input);
    const chain = response.competitors.find((item) => item.id === "osm-node-1")!;
    expect(chain).toMatchObject({ isChain: true, brand: "Great Clips", rank: null });
    expect(chain.finalScore).toBeNull();
    expect(
      vi.mocked(auditWebsite).mock.calls.map(([args]) => args.url)
    ).not.toContain("https://rival-1.example/");
    expect(() => assertRealDataResponse(response)).not.toThrow();
  });

  it("scores the user's local presence from their own matched OSM listing, citing it", async () => {
    const userListing = candidate(9, {
      name: "Acme Dental",
      website: "https://acme.example/",
      phone: "555-0199",
      address: "9 Main St",
      osmTags: { amenity: "dentist", name: "Acme Dental" },
    });
    vi.mocked(discoverCompetitors).mockResolvedValue(
      discovery([candidate(1)], { userMatch: userListing })
    );

    const response = await analyzeMarket(input);
    const listingSource = response.provenance.sources.find(
      (source) => source.url === "https://www.openstreetmap.org/node/9"
    );
    expect(listingSource).toMatchObject({ kind: "openstreetmap", status: "used" });
    expect(response.user.sourceIds).toContain(listingSource!.id);
    expect(response.user.categoryMatchScore).toBe(100);
    expect(response.user.localPresenceScore).toBe(100);
    expect(() => assertRealDataResponse(response)).not.toThrow();
  });

  it("leaves the user's directory inputs N/A when no OSM listing matched", async () => {
    vi.mocked(discoverCompetitors).mockResolvedValue(discovery([candidate(1)]));

    const response = await analyzeMarket(input);
    expect(response.user.categoryMatchScore).toBeNull();
    // Website + observed phone only: nothing unobserved is scored as absent.
    expect(response.user.localPresenceScore).toBe(100);
    expect(
      response.provenance.sources.some(
        (source) =>
          source.kind === "openstreetmap" && source.businessName === input.businessName
      )
    ).toBe(false);
  });

  it("makes one combined news request and marks unavailable news as N/A", async () => {
    vi.mocked(fetchCombinedNewsSignals).mockImplementationOnce(async (entities) => ({
      status: "unavailable",
      queryUrl: "https://api.gdeltproject.org/api/v2/doc/doc?query=combined",
      accessedAt: "2026-07-19T10:00:00.000Z",
      queried: entities.map((entity) => entity.id),
      skipped: [],
      articlesByEntity: {},
    }));

    const response = await analyzeMarket(input);

    expect(fetchCombinedNewsSignals).toHaveBeenCalledOnce();
    expect(vi.mocked(fetchCombinedNewsSignals).mock.calls[0][0]).toEqual([
      { id: "user", name: "Acme Dental" },
      { id: "osm-node-1", name: "Rival Dental" },
      { id: "osm-node-3", name: "Offline Dental" },
    ]);
    expect(response.user.signals.newsStatus).toBe("unavailable");
    const rival = response.competitors.find((item) => item.id === "osm-node-1")!;
    expect(rival.signals.newsStatus).toBe("unavailable");
    // Offline Dental's audit failed, so it takes no part in news scoring.
    const offline = response.competitors.find((item) => item.id === "osm-node-3")!;
    expect(offline.signals.newsStatus).toBe("not_requested");
    expect(response.dataQuality.unavailableFields).toEqual(
      expect.arrayContaining(["user.newsSignals", "osm-node-1.newsSignals"])
    );
    expect(() => assertRealDataResponse(response)).not.toThrow();
  });

  it("attributes combined news articles to the entity they name", async () => {
    vi.mocked(fetchCombinedNewsSignals).mockImplementationOnce(async (entities) => ({
      status: "complete",
      queryUrl: "https://api.gdeltproject.org/api/v2/doc/doc?query=combined",
      accessedAt: "2026-07-19T10:00:00.000Z",
      queried: entities.map((entity) => entity.id),
      skipped: [],
      articlesByEntity: {
        "osm-node-1": [
          {
            label: "Public news mention found",
            evidence: 'Article title: "Rival Dental opens new location"',
            sourceUrl: "https://news.example/rival-dental",
            sourceType: "news",
            confidence: "medium",
          },
        ],
      },
    }));

    const response = await analyzeMarket(input);
    const rival = response.competitors.find((item) => item.id === "osm-node-1")!;
    expect(rival.signals.newsStatus).toBe("complete");
    expect(rival.signals.newsSignals).toHaveLength(1);
    expect(response.user.signals.newsStatus).toBe("complete");
    expect(response.user.signals.newsSignals).toEqual([]);
    expect(() => assertRealDataResponse(response)).not.toThrow();
  });

  it("scores news uniformly: a searched business with no articles and an unsearched one get equal momentum", async () => {
    vi.mocked(discoverCompetitors).mockResolvedValue(
      discovery([candidate(1), candidate(2, { name: "Rx" })])
    );
    // "Rx" is too short to search, so GDELT skips it; nobody has articles.
    vi.mocked(fetchCombinedNewsSignals).mockImplementationOnce(async (entities) => ({
      status: "complete",
      queryUrl: "https://api.gdeltproject.org/api/v2/doc/doc?query=combined",
      accessedAt: "2026-07-19T10:00:00.000Z",
      queried: entities.filter((entity) => entity.name !== "Rx").map((entity) => entity.id),
      skipped: ["osm-node-2"],
      articlesByEntity: {},
    }));

    const response = await analyzeMarket(input);
    const searched = response.competitors.find((item) => item.id === "osm-node-1")!;
    const unsearched = response.competitors.find((item) => item.id === "osm-node-2")!;
    expect(searched.signals.newsStatus).toBe("complete");
    expect(unsearched.signals.newsStatus).toBe("not_requested");
    expect(searched.signals.momentumScore).not.toBeNull();
    expect(searched.signals.momentumScore).toBe(unsearched.signals.momentumScore);
    expect(searched.finalScore).toBe(unsearched.finalScore);
    expect(response.dataQuality.notes.join(" ")).toMatch(
      /news is shown where found but left out of every momentum score/
    );
    expect(() => assertRealDataResponse(response)).not.toThrow();
  });

  it("searches news for every audit target, including possible backfills", async () => {
    const candidates = Array.from({ length: 12 }, (_, index) => candidate(index + 1));
    vi.mocked(discoverCompetitors).mockResolvedValue(discovery(candidates));

    const response = await analyzeMarket(input);
    const newsIds = vi
      .mocked(fetchCombinedNewsSignals)
      .mock.calls[0][0].map((entity) => entity.id);
    expect(newsIds).toEqual([
      "user",
      ...candidates.slice(0, MAX_AUDIT_ATTEMPTS).map((item) => item.id),
    ]);
    const scored = [response.user, ...response.competitors].filter(
      (record) => record.finalScore !== null
    );
    expect(scored.every((record) => record.signals.newsStatus === "complete")).toBe(true);
  });

  it("reports the discovered count separately from the capped listed set", async () => {
    const candidates = Array.from({ length: 14 }, (_, index) => candidate(index + 1));
    vi.mocked(discoverCompetitors).mockResolvedValue(
      discovery(candidates, { truncated: true })
    );

    const response = await analyzeMarket(input);
    expect(response.competitors).toHaveLength(10);
    expect(response.dataQuality).toMatchObject({
      realCompetitorsFound: 10,
      discoveredCount: 14,
      discoveryTruncated: true,
    });
    expect(response.report.executiveSummary).toMatch(
      /found at least 14 businesses of this type within 5 km of .*; the 10 businesses listed here are/
    );
    expect(response.dataQuality.notes.join(" ")).not.toMatch(/listed nearest first/);
    expect(response.dataQuality.notes.join(" ")).toMatch(
      /OpenStreetMap listed at least 14 businesses .* this report lists 10 of them/
    );
    expect(() => assertRealDataResponse(response)).not.toThrow();
  });

  it("discloses whether robots.txt was enforced for the run", async () => {
    const saved = process.env.STRICT_ROBOTS;
    try {
      process.env.STRICT_ROBOTS = "true";
      const strict = await analyzeMarket(input);
      expect(strict.dataQuality.robotsPolicyEnforced).toBe(true);
      expect(strict.dataQuality.notes.join(" ")).not.toMatch(/robots\.txt was not checked/);

      process.env.STRICT_ROBOTS = "false";
      const lax = await analyzeMarket(input);
      expect(lax.dataQuality.robotsPolicyEnforced).toBe(false);
      expect(lax.dataQuality.notes.join(" ")).toMatch(/robots\.txt was not checked/);
    } finally {
      if (saved === undefined) delete process.env.STRICT_ROBOTS;
      else process.env.STRICT_ROBOTS = saved;
    }
  });

  it("does not start a queued competitor audit once the audit window is nearly spent", async () => {
    const candidates = Array.from({ length: 6 }, (_, index) => candidate(index + 1));
    vi.mocked(discoverCompetitors).mockResolvedValue(discovery(candidates));
    const startedAt = Date.now();
    let clock = startedAt;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => clock);
    // The first wave (user + 3 competitors) ends with 2 s of the audit window
    // left: less than the minimum start budget for the queued 4th audit.
    const auditWindowMs =
      ANALYSIS_TIMING_BUDGETS.overallMs - ANALYSIS_TIMING_BUDGETS.finalizeReserveMs;
    vi.mocked(auditWebsite).mockImplementation(async ({ url, sourceId }) => {
      await Promise.resolve();
      clock = startedAt + auditWindowMs - 2_000;
      return observedAudit(url, sourceId);
    });
    try {
      const response = await analyzeMarket(input);
      const audited = vi
        .mocked(auditWebsite)
        .mock.calls.map(([args]) => args.url)
        .filter((url) => url !== input.businessUrl);
      expect(audited).toHaveLength(ANALYSIS_TIMING_BUDGETS.auditConcurrency - 1);
      expect(response.dataQuality.auditOutcomes).toMatchObject({ auditFailed: 0 });
      expect(response.dataQuality.auditOutcomes!.notAttempted).toBeGreaterThan(0);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("dates a cached competitor list by its original retrieval, in provenance and notes", async () => {
    const retrievedAt = "2026-07-17T08:30:00.000Z";
    vi.mocked(discoverCompetitors).mockResolvedValue(
      discovery([candidate(1), candidate(2)], { accessedAt: retrievedAt, cache: "fresh" })
    );

    const response = await analyzeMarket(input);

    const overpassSource = response.provenance.sources.find(
      (source) => source.provider === "OpenStreetMap Overpass"
    );
    expect(overpassSource?.accessedAt).toBe(retrievedAt);
    // Every map record from that answer carries the same retrieval time.
    const mapRecords = response.provenance.sources.filter(
      (source) => source.provider === "OpenStreetMap"
    );
    expect(mapRecords.length).toBeGreaterThan(0);
    expect(mapRecords.every((source) => source.accessedAt === retrievedAt)).toBe(true);
    expect(response.generatedAt).not.toBe(retrievedAt);
    // Only the competitor list was cached, not the analysis.
    expect(response.dataQuality.cacheHit).toBe(false);
    expect(response.dataQuality.notes).toContain(
      "Competitor list from OpenStreetMap as retrieved on 2026-07-17 08:30 UTC (a recently saved copy of this search; OpenStreetMap was not queried again for this report)."
    );
    expect(() => assertRealDataResponse(response)).not.toThrow();
    expect(() => validateRealReport(response)).not.toThrow();
  });

  it("discloses a stale competitor list used because live OpenStreetMap was unavailable", async () => {
    const retrievedAt = "2026-07-10T23:05:59.000Z";
    vi.mocked(discoverCompetitors).mockResolvedValue(
      discovery([candidate(1), candidate(2)], { accessedAt: retrievedAt, cache: "stale" })
    );

    const response = await analyzeMarket(input);

    expect(
      response.provenance.sources.find(
        (source) => source.provider === "OpenStreetMap Overpass"
      )?.accessedAt
    ).toBe(retrievedAt);
    expect(
      response.dataQuality.notes.filter((note) =>
        note.startsWith("Competitor list from OpenStreetMap")
      )
    ).toEqual([
      "Competitor list from OpenStreetMap as retrieved on 2026-07-10 23:05 UTC. Live OpenStreetMap servers did not answer, so the most recent saved copy of this search was used; businesses that opened, closed, or changed since then are not reflected.",
    ]);
    expect(() => assertRealDataResponse(response)).not.toThrow();
    expect(() => validateRealReport(response)).not.toThrow();
  });

  it("adds no retrieval-date note to a live competitor list", async () => {
    const response = await analyzeMarket(input);
    expect(
      response.dataQuality.notes.some((note) =>
        note.startsWith("Competitor list from OpenStreetMap")
      )
    ).toBe(false);
    expect(() => validateRealReport(response)).not.toThrow();
  });

  it("serves a cached analysis with its original generatedAt, flagged as a cache hit", async () => {
    const first = await analyzeMarket(input);
    vi.mocked(readCache).mockResolvedValue(structuredClone(first) as never);
    vi.mocked(auditWebsite).mockClear();

    const cached = await analyzeMarket(input);

    expect(readCache).toHaveBeenLastCalledWith(
      "reports",
      analysisCacheKey(input),
      6 * 60 * 60 * 1000
    );
    expect(cached.generatedAt).toBe(first.generatedAt);
    expect(cached.dataQuality.cacheHit).toBe(true);
    expect(cached.dataQuality.notes.join(" ")).toContain(
      `cached analysis generated at ${first.generatedAt}`
    );
    expect(auditWebsite).not.toHaveBeenCalled();
    expect(() => assertRealDataResponse(cached)).not.toThrow();
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

  it("stops when the caller's signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("client disconnected"));
    vi.mocked(auditWebsite).mockImplementation(async ({ url, sourceId, signal }) =>
      signal?.aborted ? unavailableAudit(url, [sourceId]) : observedAudit(url, sourceId)
    );

    await expect(
      analyzeMarket(input, { signal: controller.signal })
    ).rejects.toMatchObject({ status: 504 });
    expect(writeCache).not.toHaveBeenCalled();
  });

  it("keeps the explicit worst-case network schedule below the analysis ceiling", () => {
    const worstCaseMs =
      ANALYSIS_TIMING_BUDGETS.geocodeMs +
      ANALYSIS_TIMING_BUDGETS.overpassMs +
      // The audit window is whatever remains before the finalize reserve;
      // news runs concurrently inside it.
      (ANALYSIS_TIMING_BUDGETS.overallMs -
        ANALYSIS_TIMING_BUDGETS.geocodeMs -
        ANALYSIS_TIMING_BUDGETS.overpassMs -
        ANALYSIS_TIMING_BUDGETS.finalizeReserveMs) +
      ANALYSIS_TIMING_BUDGETS.finalizeReserveMs;

    expect(worstCaseMs).toBe(ANALYSIS_TIMING_BUDGETS.overallMs);
    const auditWindowMs =
      ANALYSIS_TIMING_BUDGETS.overallMs -
      ANALYSIS_TIMING_BUDGETS.geocodeMs -
      ANALYSIS_TIMING_BUDGETS.overpassMs -
      ANALYSIS_TIMING_BUDGETS.finalizeReserveMs;
    // Two full audit waves (user + 7 competitors at concurrency 4) fit.
    expect(auditWindowMs).toBeGreaterThanOrEqual(
      Math.ceil((1 + MAX_AUDITED_COMPETITORS) / ANALYSIS_TIMING_BUDGETS.auditConcurrency) *
        ANALYSIS_TIMING_BUDGETS.auditPerEntityMs
    );
    expect(ANALYSIS_TIMING_BUDGETS.newsMs).toBeLessThan(auditWindowMs);
    expect(ANALYSIS_TIMING_BUDGETS.overallMs).toBeLessThanOrEqual(55_000);
    // Rebalanced for slow public Overpass (see ANALYSIS_TIMING_BUDGETS).
    expect(ANALYSIS_TIMING_BUDGETS).toMatchObject({
      overallMs: 55_000,
      geocodeMs: 5_000,
      overpassMs: 24_000,
      finalizeReserveMs: 2_000,
    });
    // Even the worst-case window fits a third wave for backfilled audits.
    expect(auditWindowMs).toBeGreaterThanOrEqual(
      Math.ceil((1 + MAX_AUDIT_ATTEMPTS) / ANALYSIS_TIMING_BUDGETS.auditConcurrency) *
        ANALYSIS_TIMING_BUDGETS.auditPerEntityMs
    );
  });

  it("gives the Overpass stage room to try every instance", () => {
    const { overpassMs } = ANALYSIS_TIMING_BUDGETS;
    const { hedgeDelayMs, maxAttemptTimeoutMs, maxParallelAttempts } = OVERPASS_FAILOVER;
    // The first instance can use its full client timeout...
    expect(maxAttemptTimeoutMs).toBeLessThanOrEqual(overpassMs);
    // ...and all instances run at once, the last one started with 10 s left.
    expect(maxParallelAttempts).toBe(OVERPASS_ENDPOINTS.length);
    const lastHedgeAt = (OVERPASS_ENDPOINTS.length - 1) * hedgeDelayMs;
    expect(overpassMs - lastHedgeAt).toBeGreaterThanOrEqual(10_000);
  });
});
