import pLimit from "p-limit";
import { auditWebsite, skippedAudit, type AuditResult } from "./audit";
import { readCache, writeCache, writeNamedFile } from "./cache";
import {
  discoverCompetitors,
  type DiscoveredCandidate,
} from "./discover";
import { fetchNewsSignals } from "./gdelt";
import { geocodeMarket } from "./geocode";
import { assertRealDataResponse } from "./invariants";
import { logger } from "./logger";
import {
  InsufficientRealDataError,
  SourceUnavailableError,
} from "./pipeline-errors";
import { dedupeSourceIds, ProvenanceRegistry } from "./provenance";
import { generateRecommendations } from "./recommendations";
import { generateBenchmarkReport } from "./report";
import {
  buildMarketSummary,
  computeChangeScore,
  computeFinalScore,
  computeLocalPresenceScore,
  computeMomentumScore,
  computeRiskScore,
  isScored,
  rankCompetitors,
} from "./scoring";
import { buildSignalScanFromPageTexts } from "./signals";
import type {
  AnalyzeMarketResponse,
  AuditStatus,
  CompetitorReport,
  DataQuality,
  SourceId,
} from "./types";
import type { ValidatedAnalyzeMarketRequest } from "./validation";

export const ANALYSIS_TIMING_BUDGETS = {
  overallMs: 55_000,
  geocodeMs: 5_000,
  overpassMs: 22_000,
  auditPerEntityMs: 7_000,
  auditConcurrency: 4,
  newsPerEntityMs: 3_500,
} as const;

const MAX_COMPETITORS = 10;
export const MAX_AUDITED_COMPETITORS = 7;
const GDELT_TOP_N = 3;
const NOMINATIM_SEARCH_URL = "https://nominatim.openstreetmap.org/search";

export function analysisCacheKey(
  input: ValidatedAnalyzeMarketRequest
): string {
  return JSON.stringify({
    businessName: input.businessName,
    businessUrl: input.businessUrl,
    businessType: input.businessType,
    market: input.market,
  });
}

function sourceStatusForAudit(
  status: AuditStatus
): "used" | "limited" | "unavailable" {
  if (status === "complete") return "used";
  if (status === "partial") return "limited";
  return "unavailable";
}

function bindAuditSources(args: {
  result: AuditResult;
  businessName: string;
  homepageSourceId?: SourceId;
  provenance: ProvenanceRegistry;
}): AuditResult {
  const { result, businessName, homepageSourceId, provenance } = args;
  if (homepageSourceId) {
    provenance.update(homepageSourceId, {
      status: sourceStatusForAudit(result.audit.auditStatus),
      accessedAt: result.accessedAt,
    });
  }

  const linkedAttemptSources = result.linkedPageAttempts.map((attempt) => ({
    attempt,
    sourceId: provenance.add({
      kind: "linked_page",
      provider: "Public business website",
      title: `${businessName} linked page`,
      url: attempt.url,
      businessName,
      accessedAt: attempt.accessedAt,
      status: attempt.status,
    }),
  }));

  const pageTexts = result.pageTexts.map((page) => {
    const sourceId = provenance.add({
      kind: page.sourceType,
      provider: "Public business website",
      title:
        page.sourceType === "homepage"
          ? `${businessName} homepage`
          : `${businessName} linked page`,
      url: page.url,
      businessName,
      accessedAt:
        page.sourceType === "linked_page"
          ? linkedAttemptSources.find(
              ({ attempt }) => attempt.url === page.url
            )?.attempt.accessedAt ?? result.accessedAt
          : result.accessedAt,
      status: "used",
    });
    return { ...page, sourceIds: [sourceId] };
  });

  const evidence = result.audit.evidence.map((item) => {
    if (!item.sourceUrl) return item;
    const sourceId = provenance.add({
      kind: item.sourceType === "linked_page" ? "linked_page" : "homepage",
      provider: "Public business website",
      title:
        item.sourceType === "linked_page"
          ? `${businessName} linked page`
          : `${businessName} homepage`,
      url: item.sourceUrl,
      businessName,
      accessedAt: result.accessedAt,
      status:
        result.audit.auditStatus === "unavailable"
          ? "unavailable"
          : "used",
    });
    return { ...item, sourceIds: [sourceId] };
  });
  for (const { attempt, sourceId } of linkedAttemptSources) {
    if (attempt.status !== "unavailable") continue;
    evidence.push({
      claim: `Linked page audit unavailable: ${attempt.reason ?? "fetch failed"}.`,
      sourceUrl: attempt.url,
      sourceType: "linked_page",
      sourceIds: [sourceId],
      confidence: "low",
    });
  }

  const sourceIds = dedupeSourceIds([
    ...(homepageSourceId ? [homepageSourceId] : []),
    ...pageTexts.flatMap((page) => page.sourceIds),
    ...linkedAttemptSources.map(({ sourceId }) => sourceId),
    ...evidence.flatMap((item) => item.sourceIds),
  ]);
  return {
    audit: { ...result.audit, sourceIds, evidence },
    pageTexts,
    linkedPageAttempts: result.linkedPageAttempts,
    accessedAt: result.accessedAt,
  };
}

function finalizeScores(report: CompetitorReport): void {
  report.signals.auditStatus = report.auditStatus;
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

function buildUserReport(args: {
  input: ValidatedAnalyzeMarketRequest;
  userInputSourceId: SourceId;
  homepageSourceId: SourceId;
  provenance: ProvenanceRegistry;
  rawAudit: AuditResult;
}): CompetitorReport {
  const auditResult = bindAuditSources({
    result: args.rawAudit,
    businessName: args.input.businessName,
    homepageSourceId: args.homepageSourceId,
    provenance: args.provenance,
  });
  const signals = buildSignalScanFromPageTexts(
    auditResult.pageTexts,
    auditResult.audit.socialLinks,
    auditResult.audit.auditStatus
  );
  const localPresenceScore = computeLocalPresenceScore({
    hasWebsite: true,
    hasPhoneOrEmail:
      auditResult.audit.hasPhone === true || auditResult.audit.hasEmail === true,
    hasAddressOrCoords: false,
    categoryMatch: true,
    osmCompleteness: 0,
  });
  const report: CompetitorReport = {
    id: "user",
    name: args.input.businessName,
    website: args.input.businessUrl,
    source: "user",
    sourceIds: dedupeSourceIds([
      args.userInputSourceId,
      ...auditResult.audit.sourceIds,
    ]),
    auditStatus: auditResult.audit.auditStatus,
    categoryMatchScore: 100,
    localPresenceScore,
    websiteAudit: auditResult.audit,
    signals,
    finalScore: null,
    rank: null,
  };
  finalizeScores(report);
  return report;
}

function buildCompetitorReport(args: {
  candidate: DiscoveredCandidate;
  discoverySourceId: SourceId;
  candidateSourceId: SourceId;
  homepageSourceId?: SourceId;
  provenance: ProvenanceRegistry;
  rawAudit: AuditResult;
}): CompetitorReport {
  const auditResult = bindAuditSources({
    result: args.rawAudit,
    businessName: args.candidate.name,
    homepageSourceId: args.homepageSourceId,
    provenance: args.provenance,
  });
  const signals = buildSignalScanFromPageTexts(
    auditResult.pageTexts,
    auditResult.audit.socialLinks,
    auditResult.audit.auditStatus
  );
  const observedDirectoryFields = [
    args.candidate.website,
    args.candidate.phone,
    args.candidate.address,
    args.candidate.lat !== undefined && args.candidate.lon !== undefined,
  ].filter(Boolean).length;
  const localPresenceScore = computeLocalPresenceScore({
    hasWebsite: Boolean(args.candidate.website),
    hasPhoneOrEmail: Boolean(args.candidate.phone),
    hasAddressOrCoords: Boolean(
      args.candidate.address ||
        (args.candidate.lat !== undefined && args.candidate.lon !== undefined)
    ),
    categoryMatch: true,
    osmCompleteness: observedDirectoryFields / 4,
  });
  const report: CompetitorReport = {
    id: args.candidate.id,
    name: args.candidate.name,
    website: args.candidate.website,
    phone: args.candidate.phone,
    address: args.candidate.address,
    lat: args.candidate.lat,
    lon: args.candidate.lon,
    source: "overpass",
    sourceIds: dedupeSourceIds([
      args.discoverySourceId,
      args.candidateSourceId,
      ...auditResult.audit.sourceIds,
    ]),
    auditStatus: auditResult.audit.auditStatus,
    categoryMatchScore: 80,
    localPresenceScore,
    websiteAudit: auditResult.audit,
    signals,
    finalScore: null,
    rank: null,
  };
  finalizeScores(report);
  return report;
}

async function enrichWithNews(args: {
  user: CompetitorReport;
  competitors: CompetitorReport[];
  provenance: ProvenanceRegistry;
  signal: AbortSignal;
}): Promise<string[]> {
  const initiallyRanked = rankCompetitors(args.user, args.competitors);
  const topCompetitors = initiallyRanked.competitors
    .filter(isScored)
    .slice(0, GDELT_TOP_N);
  const targets = [
    ...(isScored(initiallyRanked.user) ? [initiallyRanked.user] : []),
    ...topCompetitors,
  ];
  const results = await Promise.all(
    targets.map((target) =>
      fetchNewsSignals(target.name, {
        signal: args.signal,
        budgetMs: ANALYSIS_TIMING_BUDGETS.newsPerEntityMs,
      })
    )
  );
  const unavailableFields: string[] = [];

  targets.forEach((target, targetIndex) => {
    const result = results[targetIndex];
    target.signals.newsStatus = result.status;
    if (result.status === "unavailable") {
      const sourceId = args.provenance.add({
        kind: "news_article",
        provider: "GDELT",
        title: `${target.name} news search`,
        url: result.queryUrl,
        businessName: target.name,
        accessedAt: result.accessedAt,
        status: "unavailable",
      });
      target.sourceIds = dedupeSourceIds([...target.sourceIds, sourceId]);
      target.signals.sourceIds = dedupeSourceIds([
        ...target.signals.sourceIds,
        sourceId,
      ]);
      unavailableFields.push(`${target.id}.newsSignals`);
    } else {
      target.signals.newsSignals = result.signals.map((signal) => {
        const sourceId = args.provenance.add({
          kind: "news_article",
          provider: "GDELT",
          title: signal.evidence,
          url: signal.sourceUrl,
          businessName: target.name,
          accessedAt: result.accessedAt,
          status: "used",
        });
        return { ...signal, sourceIds: [sourceId] };
      });
      const newsSourceIds = target.signals.newsSignals.flatMap(
        (signal) => signal.sourceIds
      );
      target.signals.sourceIds = dedupeSourceIds([
        ...target.signals.sourceIds,
        ...newsSourceIds,
      ]);
      target.sourceIds = dedupeSourceIds([
        ...target.sourceIds,
        ...newsSourceIds,
      ]);
    }
    finalizeScores(target);
  });
  return unavailableFields;
}

function buildDataQuality(args: {
  user: CompetitorReport;
  competitors: CompetitorReport[];
  newsUnavailableFields: string[];
  discoveryLimited: boolean;
}): DataQuality {
  const records = [args.user, ...args.competitors];
  const failedAudits = records.filter(
    (record) => record.auditStatus === "unavailable"
  ).length;
  const limitedAudits = records.filter(
    (record) => record.auditStatus === "partial"
  ).length;
  const scoredCompetitors = args.competitors.filter(isScored).length;
  const unavailableFields = dedupeStrings([
    ...args.newsUnavailableFields,
    ...(args.discoveryLimited ? ["competitorDiscovery"] : []),
    ...records.flatMap((record) =>
      record.auditStatus === "unavailable"
        ? [
            `${record.id}.websiteAudit`,
            `${record.id}.websiteScore`,
            `${record.id}.signalScores`,
            `${record.id}.finalScore`,
            `${record.id}.rank`,
          ]
        : record.auditStatus === "partial"
          ? [`${record.id}.linkedPageCoverage`]
          : []
    ),
    ...(!isScored(args.user)
      ? ["summary.yourRank", "summary.marketGap", "summary.status"]
      : []),
    ...(scoredCompetitors === 0
      ? [
          "summary.competitorAverageWebsiteScore",
          "summary.competitorAverageFinalScore",
          "summary.strongestCompetitor",
          "summary.marketGap",
        ]
      : []),
  ]);
  const notes: string[] = [];
  if (args.competitors.length === 0) {
    notes.push(
      args.discoveryLimited
        ? "No Overpass request was made because the business type could not be resolved to supported OpenStreetMap tags."
        : "Overpass returned a valid zero-result competitor discovery."
    );
  }
  const unscoredCompetitors = args.competitors.length - scoredCompetitors;
  if (unscoredCompetitors > 0) {
    notes.push(
      `${unscoredCompetitors} discovered competitor(s) remain unscored because no usable website audit was available.`
    );
  }
  if (limitedAudits > 0) {
    notes.push(
      `${limitedAudits} audit(s) used homepage observations with limited linked-page coverage.`
    );
  }
  if (args.newsUnavailableFields.length > 0) {
    notes.push("GDELT news coverage was unavailable for one or more ranked businesses.");
  }
  const coverageStatus: AuditStatus =
    failedAudits === 0 && limitedAudits === 0 && unavailableFields.length === 0
      ? "complete"
      : records.some(isScored) || args.competitors.length > 0
        ? "partial"
        : "unavailable";
  return {
    coverageStatus,
    realCompetitorsFound: args.competitors.length,
    scoredCompetitors,
    failedAudits,
    limitedAudits,
    unavailableFields,
    cacheHit: false,
    notes,
  };
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)];
}

export async function analyzeMarket(
  input: ValidatedAnalyzeMarketRequest
): Promise<AnalyzeMarketResponse> {
  const pipelineController = new AbortController();
  const pipelineTimeout = setTimeout(
    () =>
      pipelineController.abort(new Error("Analysis time budget exhausted")),
    ANALYSIS_TIMING_BUDGETS.overallMs
  );
  try {
  const pipelineStartedAt = Date.now();
  const cacheKey = analysisCacheKey(input);
  logger.info("analyze-market pipeline started", {
    businessType: input.businessType,
    market: input.market,
  });

  const cached = await readCache<AnalyzeMarketResponse>("reports", cacheKey);
  if (cached) {
    try {
      assertRealDataResponse(cached);
      return {
        ...cached,
        dataQuality: { ...cached.dataQuality, cacheHit: true },
      };
    } catch {
      // Ignore legacy or corrupt cache values and rebuild from real sources.
    }
  }

  const generatedAt = new Date().toISOString();
  const provenance = new ProvenanceRegistry(generatedAt);
  const userInputSourceId = provenance.add({
    kind: "user_input",
    provider: "User submission",
    title: "Benchmark analysis request",
    businessName: input.businessName,
    status: "used",
  });

  const geo = await geocodeMarket(input.market, {
    signal: pipelineController.signal,
    budgetMs: ANALYSIS_TIMING_BUDGETS.geocodeMs,
  });
  const geocodeSourceId = provenance.add({
    kind: "nominatim",
    provider: "OpenStreetMap Nominatim",
    title: geo.label,
    url: `${NOMINATIM_SEARCH_URL}?q=${encodeURIComponent(input.market)}&format=jsonv2&limit=1&addressdetails=1`,
    accessedAt: geo.accessedAt,
    status: "used",
  });
  const discovery = await discoverCompetitors({
    businessType: input.businessType,
    userBusinessName: input.businessName,
    userDomain: input.businessUrl,
    lat: geo.lat,
    lon: geo.lon,
    signal: pipelineController.signal,
    budgetMs: ANALYSIS_TIMING_BUDGETS.overpassMs,
  });
  const discoverySourceId = provenance.add({
    kind: "openstreetmap",
    provider: discovery.queryPerformed
      ? "OpenStreetMap Overpass"
      : "OpenStreetMap category resolution",
    title: discovery.queryPerformed
      ? `${input.businessType} businesses near ${geo.label}`
      : `${input.businessType} category could not be resolved to OpenStreetMap tags`,
    url: discovery.queryPerformed ? discovery.endpoint : undefined,
    accessedAt: discovery.accessedAt,
    status: discovery.queryPerformed ? "used" : "limited",
  });
  const candidates = discovery.candidates.slice(0, MAX_COMPETITORS);
  const userHomepageSourceId = provenance.add({
    kind: "homepage",
    provider: "Public business website",
    title: `${input.businessName} homepage`,
    url: input.businessUrl,
    businessName: input.businessName,
    status: "used",
  });
  const candidateHomepageIds = new Map<string, SourceId>();
  const candidateSourceIds = new Map<string, SourceId>();
  for (const candidate of candidates) {
    candidateSourceIds.set(
      candidate.id,
      provenance.add({
        kind: "openstreetmap",
        provider: "OpenStreetMap",
        title: `${candidate.name} map record`,
        url: candidate.osmElementUrl,
        businessName: candidate.name,
        accessedAt: discovery.accessedAt,
        status: "used",
      })
    );
  }
  const auditedCandidateIds = new Set(
    candidates
      .filter((candidate) => candidate.website)
      .slice(0, MAX_AUDITED_COMPETITORS)
      .map((candidate) => candidate.id)
  );
  for (const candidate of candidates) {
    if (!candidate.website || !auditedCandidateIds.has(candidate.id)) continue;
    candidateHomepageIds.set(
      candidate.id,
      provenance.add({
        kind: "homepage",
        provider: "Public business website",
        title: `${candidate.name} homepage`,
        url: candidate.website,
        businessName: candidate.name,
        status: "used",
      })
    );
  }

  const limit = pLimit(ANALYSIS_TIMING_BUDGETS.auditConcurrency);
  const [rawUserAudit, ...rawCompetitorAudits] = await Promise.all([
    limit(() =>
      auditWebsite({
        url: input.businessUrl,
        businessType: input.businessType,
        market: input.market,
        sourceId: userHomepageSourceId,
        signal: pipelineController.signal,
        budgetMs: ANALYSIS_TIMING_BUDGETS.auditPerEntityMs,
      })
    ),
    ...candidates.map((candidate) =>
      candidate.website && candidateHomepageIds.has(candidate.id)
        ? limit(() =>
            auditWebsite({
              url: candidate.website!,
              businessType: input.businessType,
              market: input.market,
              sourceId: candidateHomepageIds.get(candidate.id)!,
              signal: pipelineController.signal,
              budgetMs: ANALYSIS_TIMING_BUDGETS.auditPerEntityMs,
            })
          )
        : Promise.resolve(
            skippedAudit(
              candidate.website,
              candidate.website
                ? "website audit not selected within bounded report capacity"
                : "no public website listed"
            )
          )
    ),
  ]);
  const user = buildUserReport({
    input,
    userInputSourceId,
    homepageSourceId: userHomepageSourceId,
    provenance,
    rawAudit: rawUserAudit,
  });
  const competitors = candidates.map((candidate, index) =>
    buildCompetitorReport({
      candidate,
      discoverySourceId,
      candidateSourceId: candidateSourceIds.get(candidate.id)!,
      homepageSourceId: candidateHomepageIds.get(candidate.id),
      provenance,
      rawAudit: rawCompetitorAudits[index],
    })
  );

  if (!isScored(user) && competitors.length === 0) {
    if (pipelineController.signal.aborted) {
      throw new SourceUnavailableError(
        "analysis",
        "Analysis could not complete within the request time budget.",
        pipelineController.signal.reason
      );
    }
    throw new InsufficientRealDataError();
  }

  const newsUnavailableFields = await enrichWithNews({
    user,
    competitors,
    provenance,
    signal: pipelineController.signal,
  });
  const ranked = rankCompetitors(user, competitors);
  const dataQuality = buildDataQuality({
    user: ranked.user,
    competitors: ranked.competitors,
    newsUnavailableFields,
    discoveryLimited: !discovery.queryPerformed,
  });
  const summary = buildMarketSummary(ranked.user, ranked.competitors);
  const recommendations = generateRecommendations({
    user: ranked.user,
    competitors: ranked.competitors,
  });
  const report = generateBenchmarkReport({
    input,
    user: ranked.user,
    competitors: ranked.competitors,
    summary,
    recommendations,
    dataQuality,
    discoverySourceIds: [discoverySourceId],
  });
  const response: AnalyzeMarketResponse = {
    schemaVersion: 2,
    provenance: provenance.build(),
    input,
    market: {
      label: geo.label,
      lat: geo.lat,
      lon: geo.lon,
      bbox: geo.boundingBox,
      source: "nominatim",
      sourceIds: [geocodeSourceId],
    },
    user: ranked.user,
    competitors: ranked.competitors,
    summary,
    report,
    recommendations,
    dataQuality,
    generatedAt,
  };
  assertRealDataResponse(response);
  await writeCache("reports", cacheKey, response);
  await writeNamedFile("reports", "latest-success.json", response);
  logger.info("analyze-market pipeline completed", {
    coverageStatus: dataQuality.coverageStatus,
    realCompetitorsFound: dataQuality.realCompetitorsFound,
    scoredCompetitors: dataQuality.scoredCompetitors,
    failedAudits: dataQuality.failedAudits,
    durationMs: Date.now() - pipelineStartedAt,
  });
  return response;
  } finally {
    clearTimeout(pipelineTimeout);
  }
}
