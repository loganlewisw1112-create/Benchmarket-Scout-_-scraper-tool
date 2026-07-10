import pLimit from "p-limit";
import { auditWebsite, skippedAudit, type AuditResult } from "./audit";
import { readCache, writeCache, writeNamedFile } from "./cache";
import {
  discoverCompetitors,
  type DiscoveredCandidate,
} from "./discover";
import { fetchNewsSignals } from "./gdelt";
import { geocodeMarket } from "./geocode";
import { logger } from "./logger";
import { getFullMockBundle, getMockCompetitors, seedToCompetitorReport } from "./mock-data";
import { generateRecommendations } from "./recommendations";
import { generateBenchmarkReport } from "./report";
import {
  buildMarketSummary,
  computeChangeScore,
  computeFinalScore,
  computeLocalPresenceScore,
  computeMomentumScore,
  computeRiskScore,
  rankCompetitors,
} from "./scoring";
import { buildSignalScanFromPageTexts } from "./signals";
import type {
  AnalyzeMarketResponse,
  CompetitorReport,
  DataQuality,
  DemoMode,
} from "./types";
import type { ValidatedAnalyzeMarketRequest } from "./validation";

const TARGET_TOTAL_COMPETITORS = 10;
const MIN_LIVE_COMPETITORS = 6;
const GDELT_TOP_N = 3;

function resolveDemoMode(input: ValidatedAnalyzeMarketRequest): DemoMode {
  return (
    input.options?.demoMode ??
    (process.env.DEMO_MODE as DemoMode | undefined) ??
    "auto"
  );
}

async function buildUserReport(
  input: ValidatedAnalyzeMarketRequest
): Promise<CompetitorReport> {
  const auditResult = await auditWebsite({
    url: input.businessUrl,
    businessType: input.businessType,
    market: input.market,
  });

  const signals = buildSignalScanFromPageTexts(
    auditResult.pageTexts,
    auditResult.audit.socialLinks
  );

  const localPresenceScore = computeLocalPresenceScore({
    hasWebsite: !auditResult.audit.skipped,
    hasPhoneOrEmail: auditResult.audit.hasPhone || auditResult.audit.hasEmail,
    hasAddressOrCoords: false,
    categoryMatch: true,
    osmCompleteness: 0.5,
  });

  return {
    id: "user",
    name: input.businessName,
    website: input.businessUrl,
    source: "user",
    categoryMatchScore: 100,
    localPresenceScore,
    websiteAudit: auditResult.audit,
    signals,
    finalScore: 0,
  };
}

async function buildLiveCompetitorReport(
  candidate: DiscoveredCandidate,
  businessType: string,
  market: string
): Promise<CompetitorReport> {
  let auditResult: AuditResult;

  if (!candidate.website) {
    auditResult = skippedAudit(undefined, "no public website listed");
  } else {
    auditResult = await auditWebsite({
      url: candidate.website,
      businessType,
      market,
    });
  }

  const signals = buildSignalScanFromPageTexts(
    auditResult.pageTexts,
    auditResult.audit.socialLinks
  );

  const localPresenceScore = computeLocalPresenceScore({
    hasWebsite: !!candidate.website,
    hasPhoneOrEmail: !!candidate.phone,
    hasAddressOrCoords: !!(candidate.address || (candidate.lat && candidate.lon)),
    categoryMatch: true,
    osmCompleteness: 0.7,
  });

  return {
    id: candidate.id,
    name: candidate.name,
    website: candidate.website,
    phone: candidate.phone,
    address: candidate.address,
    lat: candidate.lat,
    lon: candidate.lon,
    source: "overpass",
    categoryMatchScore: 80,
    localPresenceScore,
    websiteAudit: auditResult.audit,
    signals,
    finalScore: 0,
  };
}

function finalizeScores(report: CompetitorReport): void {
  report.signals.momentumScore = computeMomentumScore(report.signals);
  report.signals.riskScore = computeRiskScore(report.signals);
  report.signals.changeScore = computeChangeScore(report.signals);
  report.finalScore = computeFinalScore({
    websiteScore: report.websiteAudit.websiteScore,
    localPresenceScore: report.localPresenceScore,
    momentumScore: report.signals.momentumScore,
    riskScore: report.signals.riskScore,
  });
}

async function enrichWithNews(
  user: CompetitorReport,
  competitors: CompetitorReport[]
): Promise<void> {
  const liveCompetitors = competitors.filter((c) => c.source !== "mock");
  const topCompetitors = [...liveCompetitors]
    .sort((a, b) => b.finalScore - a.finalScore)
    .slice(0, GDELT_TOP_N);

  const targets = [user, ...topCompetitors];

  await Promise.all(
    targets.map(async (target) => {
      const news = await fetchNewsSignals(target.name);
      target.signals.newsSignals = news;
      finalizeScores(target);
    })
  );
}

async function buildMockOnlyResponse(
  input: ValidatedAnalyzeMarketRequest
): Promise<AnalyzeMarketResponse> {
  const bundle = await getFullMockBundle(input.businessType);
  const competitors = bundle.competitors
    .slice(0, TARGET_TOTAL_COMPETITORS)
    .map((seed, idx) => seedToCompetitorReport(seed, idx));

  competitors.forEach(finalizeScores);

  const user = await buildUserReport(input);
  finalizeScores(user);

  const { user: rankedUser, competitors: rankedCompetitors } = rankCompetitors(
    user,
    competitors
  );

  const summary = buildMarketSummary(rankedUser, rankedCompetitors);
  const recommendations = generateRecommendations({
    user: rankedUser,
    competitors: rankedCompetitors,
  });

  const dataQuality: DataQuality = {
    discoverySource: "mock",
    usedMockData: true,
    liveCompetitorsFound: 0,
    failedHomepageFetches: rankedUser.websiteAudit.skipped ? 1 : 0,
    limitedAudits: 0,
    cacheHit: false,
    notes: [
      "Mock demo mode is active. All competitor rows use labeled fallback demo data.",
    ],
  };

  const report = generateBenchmarkReport({
    input,
    user: rankedUser,
    competitors: rankedCompetitors,
    summary,
    recommendations,
    dataQuality,
  });

  const response: AnalyzeMarketResponse = {
    input,
    market: {
      label: `${input.market} (mock mode)`,
      source: "mock",
    },
    user: rankedUser,
    competitors: rankedCompetitors,
    summary,
    report,
    recommendations,
    dataQuality,
    generatedAt: new Date().toISOString(),
  };

  await writeNamedFile("reports", "latest-success.json", response);
  return response;
}

export async function analyzeMarket(
  input: ValidatedAnalyzeMarketRequest
): Promise<AnalyzeMarketResponse> {
  const pipelineStartedAt = Date.now();
  const demoMode = resolveDemoMode(input);

  logger.info("analyze-market pipeline started", {
    businessType: input.businessType,
    market: input.market,
    demoMode,
  });

  const cacheKey = JSON.stringify({
    businessName: input.businessName,
    businessUrl: input.businessUrl,
    businessType: input.businessType,
    market: input.market,
    demoMode,
  });

  if (demoMode !== "mock") {
    const cached = await readCache<AnalyzeMarketResponse>("reports", cacheKey);
    if (cached) {
      logger.info("analyze-market cache hit", {
        businessType: input.businessType,
        market: input.market,
        demoMode,
      });
      return {
        ...cached,
        dataQuality: { ...cached.dataQuality, cacheHit: true },
      };
    }
  }

  if (demoMode === "mock") {
    const mockResponse = await buildMockOnlyResponse(input);
    logger.info("analyze-market pipeline completed", {
      discoverySource: "mock",
      usedMockData: true,
      liveCompetitorsFound: 0,
      durationMs: Date.now() - pipelineStartedAt,
    });
    return mockResponse;
  }

  const notes: string[] = [];

  const geo = await geocodeMarket(input.market);
  if (geo.source === "mock") {
    notes.push(
      "Nominatim geocoding was unavailable; approximate fallback market coordinates were used."
    );
  }

  const discovery = await discoverCompetitors({
    businessType: input.businessType,
    market: input.market,
    userBusinessName: input.businessName,
    userDomain: input.businessUrl,
    lat: geo.lat,
    lon: geo.lon,
    demoMode,
  });

  if (discovery.overpassFailed) {
    notes.push(
      demoMode === "live"
        ? "Overpass/OpenStreetMap discovery was unavailable; no live competitors could be discovered."
        : "Overpass/OpenStreetMap discovery was unavailable; fallback demo competitors were used."
    );
  }

  const liveCandidates = discovery.candidates.slice(0, TARGET_TOTAL_COMPETITORS);

  const limit = pLimit(3);

  const [userReport, ...liveCompetitorReports] = await Promise.all([
    limit(() => buildUserReport(input)),
    ...liveCandidates.map((candidate) =>
      limit(() =>
        buildLiveCompetitorReport(candidate, input.businessType, input.market)
      )
    ),
  ]);

  let competitors = liveCompetitorReports;
  let usedMockData = false;

  if (competitors.length < MIN_LIVE_COMPETITORS && demoMode !== "live") {
    const needed = TARGET_TOTAL_COMPETITORS - competitors.length;
    logger.warn(
      "competitor discovery yielded too few live results; padding with mock competitors",
      {
        liveCount: competitors.length,
        added: needed,
        businessType: input.businessType,
        market: input.market,
      }
    );
    const mockCompetitors = await getMockCompetitors(input.businessType, needed);
    competitors = [...competitors, ...mockCompetitors];
    usedMockData = true;
    notes.push(
      "Fewer than 6 live competitors were found from free public data; labeled fallback demo rows were added to complete the market comparison."
    );
  } else if (competitors.length < MIN_LIVE_COMPETITORS) {
    notes.push(
      "Live demo mode: fewer than 6 live competitors were found and no fallback demo rows were added."
    );
  }

  competitors.forEach(finalizeScores);
  finalizeScores(userReport);

  await enrichWithNews(userReport, competitors);

  const { user: rankedUser, competitors: rankedCompetitors } = rankCompetitors(
    userReport,
    competitors
  );

  const failedHomepageFetches =
    (rankedUser.websiteAudit.skipped ? 1 : 0) +
    rankedCompetitors.filter(
      (c) => c.source !== "mock" && c.websiteAudit.skipped
    ).length;

  const auditedLiveCount =
    rankedCompetitors.filter((c) => c.source !== "mock").length + 1;

  if (failedHomepageFetches / auditedLiveCount > 0.4) {
    notes.push(
      "More than 40% of homepage fetches failed; audit coverage is limited for this run."
    );
  }

  const limitedAudits =
    (rankedUser.websiteAudit.reason && !rankedUser.websiteAudit.skipped ? 1 : 0) +
    rankedCompetitors.filter(
      (c) => c.websiteAudit.reason && !c.websiteAudit.skipped
    ).length;

  const liveCompetitorsFound = rankedCompetitors.filter(
    (c) => c.source !== "mock"
  ).length;

  const discoverySource: DataQuality["discoverySource"] = usedMockData
    ? liveCompetitorsFound > 0
      ? "mixed"
      : "mock"
    : "overpass";

  const dataQuality: DataQuality = {
    discoverySource,
    usedMockData,
    liveCompetitorsFound,
    failedHomepageFetches,
    limitedAudits,
    cacheHit: false,
    notes,
  };

  const summary = buildMarketSummary(rankedUser, rankedCompetitors);
  const recommendations = generateRecommendations({
    user: rankedUser,
    competitors: rankedCompetitors,
  });
  const report = generateBenchmarkReport({
    input,
    user: rankedUser,
    competitors: rankedCompetitors,
    summary,
    recommendations,
    dataQuality,
  });

  const response: AnalyzeMarketResponse = {
    input,
    market: {
      label: geo.label,
      lat: geo.lat,
      lon: geo.lon,
      bbox: geo.boundingBox,
      source: geo.source,
    },
    user: rankedUser,
    competitors: rankedCompetitors,
    summary,
    report,
    recommendations,
    dataQuality,
    generatedAt: new Date().toISOString(),
  };

  await writeCache("reports", cacheKey, response);
  await writeNamedFile("reports", "latest-success.json", response);

  logger.info("analyze-market pipeline completed", {
    discoverySource,
    usedMockData,
    liveCompetitorsFound,
    failedHomepageFetches,
    durationMs: Date.now() - pipelineStartedAt,
  });

  return response;
}
