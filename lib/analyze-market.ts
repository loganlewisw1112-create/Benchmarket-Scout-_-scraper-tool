import pLimit from "p-limit";
import { auditWebsite, skippedAudit, type AuditResult } from "./audit";
import { CACHE_TTL, readCache, writeCache, writeNamedFile } from "./cache";
import {
  discoverCompetitors,
  type DiscoveredCandidate,
  type DiscoveryResult,
} from "./discover";
import { fetchCombinedNewsSignals, type CombinedNewsResult } from "./gdelt";
import { geocodeMarket, nominatimSearchUrl } from "./geocode";
import { assertRealDataResponse } from "./invariants";
import { logger } from "./logger";
import { overpassTurboUrl } from "./overpass";
import {
  AnalysisTimeoutError,
  IndustryNotResolvedError,
  NoCompetitorsFoundError,
  UserSiteUnavailableError,
} from "./pipeline-errors";
import { dedupeSourceIds, ProvenanceRegistry } from "./provenance";
import { generateRecommendations } from "./recommendations";
import { generateBenchmarkReport } from "./report";
import { isRobotsPolicyEnforced } from "./robots";
import {
  buildMarketSummary,
  computeCategoryMatch,
  computeChangeScore,
  computeFinalScore,
  computeLocalPresenceScore,
  computeMomentumScore,
  computeRiskScore,
  countAuditOutcomes,
  type LocalPresenceInputs,
  isScored,
  observedContactDetails,
  rankCompetitors,
} from "./scoring";
import { buildSignalScanFromPageTexts } from "./signals";
import { createTimedSignal, remainingBudgetMs } from "./time-budget";
import type {
  AnalyzeMarketResponse,
  AuditFailureCode,
  AuditStatus,
  CompetitorReport,
  DataQuality,
  SourceId,
} from "./types";
import type { ValidatedAnalyzeMarketRequest } from "./validation";

/**
 * Stage budgets. Geocode and discovery run in sequence; the audits then run
 * until the overall deadline minus `finalizeReserveMs`, with the single news
 * request running concurrently. Worst case: 5 + 24 + 24 + 2 = 55 s, inside
 * the route's 60 s maxDuration.
 *
 * Discovery gets 24 s because public Overpass instances are often slow under
 * load: the first instance can use its full 21 s client timeout, and with the
 * 7 s hedge all three instances are started by 14 s with at least 10 s each
 * (OVERPASS_FAILOVER in lib/overpass.ts). A discovery cache hit takes
 * milliseconds, and the audits inherit any unused time, because their window
 * ends at a fixed deadline instead of lasting a fixed length. Even the
 * worst-case 24 s audit window fits three full 7 s waves at concurrency 4
 * (21 s): two for the user plus seven competitors, one for backfills. News
 * (11 s) runs inside that window.
 */
export const ANALYSIS_TIMING_BUDGETS = {
  overallMs: 55_000,
  geocodeMs: 5_000,
  overpassMs: 24_000,
  auditPerEntityMs: 7_000,
  auditConcurrency: 4,
  // One combined GDELT request, started with the audits (see lib/gdelt.ts).
  newsMs: 11_000,
  // Kept free at the end for ranking, report assembly and persistence.
  finalizeReserveMs: 2_000,
} as const;

/** Most competitors listed in one report (audited ones included). */
export const MAX_COMPETITORS = 10;
/** Target number of successfully audited competitors. */
export const MAX_AUDITED_COMPETITORS = 7;
/**
 * Audit attempts including backfills: when an audit fails, the next-nearest
 * candidate with a website is tried, up to this many attempts in total.
 */
export const MAX_AUDIT_ATTEMPTS = MAX_COMPETITORS;
// A backfill audit is only started when at least this much of the audit
// window remains; a shorter attempt would almost always time out.
const MIN_AUDIT_START_MS = 3_000;

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

/**
 * A cached analysis (≤6 h old), marked as a cache hit. It keeps its original
 * generatedAt and says so in its notes, so it is never presented as newly
 * generated. Invalid or legacy cache entries are ignored.
 */
export async function readCachedAnalysis(
  input: ValidatedAnalyzeMarketRequest
): Promise<AnalyzeMarketResponse | null> {
  const cached = await readCache<AnalyzeMarketResponse>(
    "reports",
    analysisCacheKey(input),
    CACHE_TTL.reports
  );
  if (!cached) return null;
  try {
    assertRealDataResponse(cached);
  } catch {
    return null;
  }
  const note = `Served from a cached analysis generated at ${cached.generatedAt}; public sources were not re-fetched for this request.`;
  return {
    ...cached,
    dataQuality: {
      ...cached.dataQuality,
      cacheHit: true,
      notes: [
        ...cached.dataQuality.notes.filter((existing) => existing !== note),
        note,
      ],
    },
  };
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

function finalizeScores(
  report: CompetitorReport,
  options: { countNews?: boolean } = {}
): void {
  report.signals.auditStatus = report.auditStatus;
  report.signals.momentumScore = computeMomentumScore(report.signals, options);
  report.signals.riskScore = computeRiskScore(report.signals);
  report.signals.changeScore = computeChangeScore(report.signals);
  report.finalScore = computeFinalScore({
    websiteScore: report.websiteAudit.websiteScore,
    localPresenceScore: report.localPresenceScore,
    momentumScore: report.signals.momentumScore,
    riskScore: report.signals.riskScore,
  });
}

/**
 * Directory-derived local-presence inputs from an OSM element, shared by the
 * user's own matched listing and every competitor so both are scored on the
 * same evidence classes.
 */
function directoryPresenceInputs(args: {
  candidate: DiscoveredCandidate;
  audit: AuditResult["audit"];
  businessType: string;
  resolvedTags: DiscoveryResult["resolution"]["tags"];
}): { inputs: LocalPresenceInputs; categoryMatch: number | null } {
  const { candidate } = args;
  const observedDirectoryFields = [
    candidate.website,
    candidate.phone,
    candidate.address,
    candidate.lat !== undefined && candidate.lon !== undefined,
  ].filter(Boolean).length;
  // Observed from the element's own OSM tags; N/A when they are not known.
  const categoryMatch = computeCategoryMatch(
    candidate.osmTags,
    args.resolvedTags,
    args.businessType
  );
  return {
    categoryMatch,
    inputs: {
      hasWebsite: Boolean(candidate.website),
      hasPhoneOrEmail:
        Boolean(candidate.phone) || observedContactDetails(args.audit) === true,
      hasAddressOrCoords: Boolean(
        candidate.address ||
          (candidate.lat !== undefined && candidate.lon !== undefined)
      ),
      categoryMatch,
      osmCompleteness: observedDirectoryFields / 4,
    },
  };
}

function buildUserReport(args: {
  input: ValidatedAnalyzeMarketRequest;
  userInputSourceId: SourceId;
  homepageSourceId: SourceId;
  provenance: ProvenanceRegistry;
  rawAudit: AuditResult;
  /** The user's own OSM listing, when discovery matched one. */
  userMatch?: DiscoveredCandidate;
  userMatchSourceId?: SourceId;
  resolvedTags: DiscoveryResult["resolution"]["tags"];
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
  // With a matched OSM listing the user is scored on the same directory
  // evidence as competitors. Without one, the directory inputs are N/A (left
  // out of the maximum), never scored as absent.
  const directory = args.userMatch
    ? directoryPresenceInputs({
        candidate: args.userMatch,
        audit: auditResult.audit,
        businessType: args.input.businessType,
        resolvedTags: args.resolvedTags,
      })
    : null;
  const localPresenceScore = computeLocalPresenceScore(
    directory
      ? { ...directory.inputs, hasWebsite: true }
      : {
          hasWebsite: true,
          hasPhoneOrEmail: observedContactDetails(auditResult.audit),
          hasAddressOrCoords: null,
          categoryMatch: null,
          osmCompleteness: null,
        }
  );
  const categoryMatch = directory?.categoryMatch ?? null;
  const report: CompetitorReport = {
    id: "user",
    name: args.input.businessName,
    website: args.input.businessUrl,
    source: "user",
    sourceIds: dedupeSourceIds([
      args.userInputSourceId,
      ...(args.userMatchSourceId ? [args.userMatchSourceId] : []),
      ...auditResult.audit.sourceIds,
    ]),
    auditStatus: auditResult.audit.auditStatus,
    categoryMatchScore:
      categoryMatch === null ? null : Math.round(categoryMatch * 100),
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
  businessType: string;
  resolvedTags: DiscoveryResult["resolution"]["tags"];
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
  const { inputs, categoryMatch } = directoryPresenceInputs({
    candidate: args.candidate,
    audit: auditResult.audit,
    businessType: args.businessType,
    resolvedTags: args.resolvedTags,
  });
  const localPresenceScore = computeLocalPresenceScore(inputs);
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
    categoryMatchScore:
      categoryMatch === null ? null : Math.round(categoryMatch * 100),
    localPresenceScore,
    websiteAudit: auditResult.audit,
    signals,
    finalScore: null,
    rank: null,
    ...(args.candidate.distanceKm !== undefined
      ? { distanceKm: args.candidate.distanceKm }
      : {}),
    ...(args.candidate.isChain
      ? { isChain: true, brand: args.candidate.brand ?? args.candidate.name }
      : {}),
  };
  finalizeScores(report);
  return report;
}

/**
 * Attach the combined GDELT result to the records it covered (contract 7).
 * Only records with a usable audit take part in scoring, so only they get a
 * news status; everything else stays "not_requested".
 *
 * News only counts toward momentum when it was searched for every scored
 * record. Otherwise a searched business with no articles would lose points
 * that an unsearched one keeps (news N/A), so observed articles are still
 * shown but left out of every momentum score (`newsCounted: false`).
 */
function applyNews(args: {
  news: CombinedNewsResult;
  records: CompetitorReport[];
  provenance: ProvenanceRegistry;
}): { unavailableFields: string[]; newsCounted: boolean } {
  const { news, provenance } = args;
  const unavailableFields: string[] = [];
  const queried = new Set(news.queried);
  const scored = args.records.filter(
    (record) => record.auditStatus !== "unavailable"
  );
  const covered = scored.filter((record) => queried.has(record.id));
  const newsCounted =
    news.status === "complete" &&
    scored.length > 0 &&
    covered.length === scored.length;
  if (covered.length === 0) return { unavailableFields, newsCounted };
  const searchSourceId = provenance.add({
    kind: "news_article",
    provider: "GDELT",
    title: `GDELT news search (${covered.length} ${covered.length === 1 ? "business" : "businesses"}, last 30 days)`,
    url: news.queryUrl,
    accessedAt: news.accessedAt,
    status: news.status === "complete" ? "used" : "unavailable",
  });

  for (const target of covered) {
    target.signals.newsStatus = news.status;
    if (news.status === "unavailable") {
      target.sourceIds = dedupeSourceIds([...target.sourceIds, searchSourceId]);
      target.signals.sourceIds = dedupeSourceIds([
        ...target.signals.sourceIds,
        searchSourceId,
      ]);
      unavailableFields.push(`${target.id}.newsSignals`);
    } else {
      target.signals.newsSignals = (news.articlesByEntity[target.id] ?? []).map(
        (signal) => {
          const sourceId = provenance.add({
            kind: "news_article",
            provider: "GDELT",
            title: signal.evidence,
            url: signal.sourceUrl,
            businessName: target.name,
            accessedAt: news.accessedAt,
            status: "used",
          });
          return { ...signal, sourceIds: [sourceId] };
        }
      );
      // The search itself is the evidence for "no matching articles".
      const newsSourceIds = [
        searchSourceId,
        ...target.signals.newsSignals.flatMap((signal) => signal.sourceIds),
      ];
      target.signals.sourceIds = dedupeSourceIds([
        ...target.signals.sourceIds,
        ...newsSourceIds,
      ]);
      target.sourceIds = dedupeSourceIds([...target.sourceIds, ...newsSourceIds]);
    }
    finalizeScores(target, { countNews: newsCounted });
  }
  return { unavailableFields, newsCounted };
}

function buildDataQuality(args: {
  user: CompetitorReport;
  competitors: CompetitorReport[];
  newsUnavailableFields: string[];
  /** False when observed news was left out of momentum (see applyNews). */
  newsCounted: boolean;
  newsObserved: boolean;
  discovery: DiscoveryResult;
}): DataQuality {
  const records = [args.user, ...args.competitors];
  const failedAudits = records.filter(
    (record) => record.auditStatus === "unavailable"
  ).length;
  const limitedAudits = records.filter(
    (record) => record.auditStatus === "partial"
  ).length;
  const scoredCompetitors = args.competitors.filter(isScored).length;
  const auditOutcomes = countAuditOutcomes(args.competitors);
  const unavailableFields = dedupeStrings([
    ...args.newsUnavailableFields,
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
  const discoveredCount = args.discovery.candidates.length;
  const robotsPolicyEnforced = isRobotsPolicyEnforced();
  const notes: string[] = [
    `Competitors were searched within ${args.discovery.radiusKm} km of the market center; the nearest ones with a website were audited first. Scored competitors are listed by score, then unscored ones.`,
  ];
  // A cached competitor list is dated by when OpenStreetMap answered, never
  // by when this report was generated (see lib/overpass.ts).
  if (args.discovery.cache) {
    const retrievedOn = formatUtcMinute(args.discovery.accessedAt);
    notes.push(
      args.discovery.cache === "stale"
        ? `Competitor list from OpenStreetMap as retrieved on ${retrievedOn}. Live OpenStreetMap servers did not answer, so the most recent saved copy of this search was used; businesses that opened, closed, or changed since then are not reflected.`
        : `Competitor list from OpenStreetMap as retrieved on ${retrievedOn} (a recently saved copy of this search; OpenStreetMap was not queried again for this report).`
    );
  }
  if (discoveredCount > args.competitors.length) {
    notes.push(
      `OpenStreetMap listed ${args.discovery.truncated ? "at least " : ""}${discoveredCount} businesses of this type in that radius; this report lists ${args.competitors.length} of them (every audited one plus the nearest others).`
    );
  }
  if (args.discovery.truncated) {
    notes.push(
      "OpenStreetMap returned its maximum number of results even at the narrowest search radius, so some nearby businesses may be missing."
    );
  }
  const unscoredParts = [
    auditOutcomes.noWebsite > 0 ? `${auditOutcomes.noWebsite} had no website listed` : "",
    auditOutcomes.auditFailed > 0
      ? `${auditOutcomes.auditFailed} website ${auditOutcomes.auditFailed === 1 ? "audit" : "audits"} failed`
      : "",
    auditOutcomes.notAttempted > 0
      ? `${auditOutcomes.notAttempted} ${auditOutcomes.notAttempted === 1 ? "was" : "were"} not audited because of the report's audit limit`
      : "",
    auditOutcomes.excludedChains > 0
      ? `${auditOutcomes.excludedChains} ${auditOutcomes.excludedChains === 1 ? "is a corporate chain location" : "are corporate chain locations"}`
      : "",
  ].filter(Boolean);
  if (unscoredParts.length > 0) {
    notes.push(`Unscored competitors: ${unscoredParts.join("; ")}.`);
  }
  if (!robotsPolicyEnforced) {
    notes.push(
      "robots.txt was not checked before these website audits (STRICT_ROBOTS was off when this report ran)."
    );
  }
  if (limitedAudits > 0) {
    notes.push(
      `${limitedAudits} ${limitedAudits === 1 ? "audit" : "audits"} used homepage observations with limited linked-page coverage.`
    );
  }
  if (args.newsUnavailableFields.length > 0) {
    notes.push(
      "GDELT news search was unavailable, so news is N/A (not zero) for the businesses it covered."
    );
  } else if (args.newsObserved && !args.newsCounted) {
    notes.push(
      "GDELT news could not be searched for every scored business (names shorter than 4 characters, or shared by two businesses, are not searched), so news is shown where found but left out of every momentum score."
    );
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
    auditOutcomes,
    discoveredCount,
    discoveryTruncated: args.discovery.truncated,
    robotsPolicyEnforced,
  };
}

/** "2026-09-22 14:05 UTC", for dates quoted in report notes. */
function formatUtcMinute(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)];
}

const USER_SITE_MESSAGES: Partial<Record<AuditFailureCode, string>> = {
  blocked_by_site:
    "Your website refused our automated check (an access-denied or rate-limit response, which bot protection often sends to cloud servers).",
  timeout: "Your website did not respond within the analysis time limit.",
  insufficient_content:
    "Your homepage had too little readable text to audit. It may need JavaScript to show its content, or it only redirects elsewhere.",
  dns_unresolved:
    "Your website's domain does not resolve. Check the URL for typos.",
  dns_error: "Your website's domain could not be looked up.",
  robots_disallowed:
    "Your website's robots.txt does not allow automated audits of its homepage.",
  tls_error: "A secure (HTTPS) connection to your website failed.",
  connection_failed: "Your website could not be reached.",
  blocked_url: "Your website address failed the public-URL safety check.",
};

/**
 * The user's own audit is the report's subject: without it there is nothing
 * to benchmark, so the analysis stops with a typed 422 and saves nothing
 * rather than publishing a competitor list with the user unranked.
 */
function userSiteUnavailable(audit: AuditResult["audit"]): UserSiteUnavailableError {
  const code = audit.reasonCode;
  const detail =
    (code && USER_SITE_MESSAGES[code]) ??
    `Your website could not be audited (${audit.reason ?? "fetch failed"}).`;
  return new UserSiteUnavailableError(
    code ?? "audit_failed",
    `${detail} Benchmark Scout needs to read your homepage to compare it with competitors, so no report was saved.`
  );
}

/** Nearest candidates first; the ones worth auditing are those with a site. */
function auditTargetsOf(candidates: DiscoveredCandidate[]): DiscoveredCandidate[] {
  return candidates.filter((candidate) => candidate.website && !candidate.isChain);
}

/**
 * Audit the user and the nearest competitor websites. Up to
 * MAX_AUDITED_COMPETITORS successful audits are collected; each failed audit
 * is backfilled with the next-nearest candidate that has a website, while
 * attempts and the audit window allow. A failed user audit aborts the rest.
 */
async function runAudits(args: {
  input: ValidatedAnalyzeMarketRequest;
  targets: DiscoveredCandidate[];
  userHomepageSourceId: SourceId;
  sourceIdFor: (candidate: DiscoveredCandidate) => SourceId;
  signal: AbortSignal;
  abortStage: (reason: unknown) => void;
  deadlineAt: number;
}): Promise<{ user: AuditResult; competitors: Map<string, AuditResult> }> {
  const limit = pLimit(ANALYSIS_TIMING_BUDGETS.auditConcurrency);
  const budgetFor = () =>
    Math.min(
      ANALYSIS_TIMING_BUDGETS.auditPerEntityMs,
      remainingBudgetMs(args.deadlineAt)
    );
  const userAudit = limit(() =>
    auditWebsite({
      url: args.input.businessUrl,
      businessType: args.input.businessType,
      market: args.input.market,
      sourceId: args.userHomepageSourceId,
      signal: args.signal,
      budgetMs: budgetFor(),
    })
  ).then((result) => {
    if (result.audit.auditStatus === "unavailable") {
      args.abortStage(new Error("user website audit unavailable"));
    }
    return result;
  });

  const results = new Map<string, AuditResult>();
  let next = 0;
  let inflight = 0;
  let succeeded = 0;
  const canStart = () =>
    next < args.targets.length &&
    results.size + inflight < MAX_AUDIT_ATTEMPTS &&
    succeeded + inflight < MAX_AUDITED_COMPETITORS &&
    !args.signal.aborted &&
    remainingBudgetMs(args.deadlineAt) >= MIN_AUDIT_START_MS;
  const worker = async (): Promise<void> => {
    while (canStart()) {
      const candidate = args.targets[next++];
      inflight++;
      try {
        // A worker can wait several seconds for a concurrency slot, so the
        // start condition is re-checked once it has one. A candidate that no
        // longer fits the window is left unaudited ("not selected"), not
        // started with no budget and then reported as its site's failure.
        const result = await limit(() =>
          remainingBudgetMs(args.deadlineAt) < MIN_AUDIT_START_MS || args.signal.aborted
            ? null
            : auditWebsite({
                url: candidate.website!,
                businessType: args.input.businessType,
                market: args.input.market,
                sourceId: args.sourceIdFor(candidate),
                signal: args.signal,
                budgetMs: budgetFor(),
              })
        );
        if (!result) continue;
        results.set(candidate.id, result);
        if (result.audit.auditStatus !== "unavailable") succeeded++;
      } finally {
        inflight--;
      }
    }
  };
  const [user] = await Promise.all([
    userAudit,
    ...Array.from({ length: ANALYSIS_TIMING_BUDGETS.auditConcurrency }, worker),
  ]);
  return { user, competitors: results };
}

export type AnalyzeMarketOptions = {
  /** Aborts the whole pipeline, e.g. when the client disconnects. */
  signal?: AbortSignal;
};

export async function analyzeMarket(
  input: ValidatedAnalyzeMarketRequest,
  options: AnalyzeMarketOptions = {}
): Promise<AnalyzeMarketResponse> {
  const pipelineStartedAt = Date.now();
  const deadlineAt = pipelineStartedAt + ANALYSIS_TIMING_BUDGETS.overallMs;
  const pipeline = createTimedSignal(
    options.signal,
    ANALYSIS_TIMING_BUDGETS.overallMs
  );
  const timeoutError = (cause?: unknown) =>
    new AnalysisTimeoutError(
      "Analysis could not complete within the request time budget.",
      cause
    );
  try {
    const cacheKey = analysisCacheKey(input);
    logger.info("analyze-market pipeline started", {
      businessType: input.businessType,
      market: input.market,
    });

    const cached = await readCachedAnalysis(input);
    if (cached) {
      logger.info("analyze-market served from cache", {
        generatedAt: cached.generatedAt,
      });
      return cached;
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
      signal: pipeline.signal,
      budgetMs: ANALYSIS_TIMING_BUDGETS.geocodeMs,
    });
    const geocodeSourceId = provenance.add({
      kind: "nominatim",
      provider: "OpenStreetMap Nominatim",
      title: geo.label,
      url: geo.queryUrl ?? nominatimSearchUrl(input.market),
      accessedAt: geo.accessedAt,
      status: "used",
    });

    const discovery = await discoverCompetitors({
      businessType: input.businessType,
      userBusinessName: input.businessName,
      userDomain: input.businessUrl,
      lat: geo.lat,
      lon: geo.lon,
      bbox: geo.boundingBox,
      signal: pipeline.signal,
      budgetMs: ANALYSIS_TIMING_BUDGETS.overpassMs,
    });
    if (!discovery.queryPerformed) {
      throw new IndustryNotResolvedError(input.businessType);
    }
    if (discovery.candidates.length === 0) {
      // Probe tags are literal guesses: finding nothing with them means the
      // type was not understood, not that the market has no such businesses.
      if (discovery.resolution.stage !== "map") {
        throw new IndustryNotResolvedError(input.businessType);
      }
      throw new NoCompetitorsFoundError(
        input.businessType,
        geo.label,
        discovery.radiusKm
      );
    }
    const discoverySourceId = provenance.add({
      kind: "openstreetmap",
      provider: "OpenStreetMap Overpass",
      title: `${input.businessType} businesses within ${discovery.radiusKm} km of ${geo.label}`,
      // A reproducible, clickable citation: overpass-turbo opens the exact
      // query. The raw API endpoint answers a browser GET with HTTP 406.
      url: discovery.query ? overpassTurboUrl(discovery.query) : discovery.endpoint,
      accessedAt: discovery.accessedAt,
      status: discovery.truncated ? "limited" : "used",
    });

    // Candidates arrive nearest first. Audit targets are the nearest ones
    // with an independent website; chain locations are listed, not audited.
    const auditTargets = auditTargetsOf(discovery.candidates).slice(
      0,
      MAX_AUDIT_ATTEMPTS
    );
    const userHomepageSourceId = provenance.add({
      kind: "homepage",
      provider: "Public business website",
      title: `${input.businessName} homepage`,
      url: input.businessUrl,
      businessName: input.businessName,
      status: "used",
    });
    const candidateHomepageIds = new Map<string, SourceId>();
    const homepageSourceFor = (candidate: DiscoveredCandidate): SourceId => {
      const existing = candidateHomepageIds.get(candidate.id);
      if (existing) return existing;
      const id = provenance.add({
        kind: "homepage",
        provider: "Public business website",
        title: `${candidate.name} homepage`,
        url: candidate.website,
        businessName: candidate.name,
        status: "used",
      });
      candidateHomepageIds.set(candidate.id, id);
      return id;
    };

    // The audit stage can be cut short by the user's own audit failing.
    const auditDeadlineAt = deadlineAt - ANALYSIS_TIMING_BUDGETS.finalizeReserveMs;
    const auditStage = new AbortController();
    const abortAuditStage = () => auditStage.abort(pipeline.signal.reason);
    if (pipeline.signal.aborted) abortAuditStage();
    else pipeline.signal.addEventListener("abort", abortAuditStage, { once: true });

    // One combined GDELT request, concurrent with the audits: the user plus
    // every audit target, including possible backfills, so news can be
    // counted uniformly for whichever competitors end up scored.
    const newsEntities = [
      { id: "user", name: input.businessName },
      ...auditTargets.map((candidate) => ({ id: candidate.id, name: candidate.name })),
    ];
    const newsPromise = fetchCombinedNewsSignals(newsEntities, {
      signal: auditStage.signal,
      budgetMs: Math.min(
        ANALYSIS_TIMING_BUDGETS.newsMs,
        remainingBudgetMs(auditDeadlineAt)
      ),
    });
    let audits: Awaited<ReturnType<typeof runAudits>>;
    let news: CombinedNewsResult;
    try {
      [audits, news] = await Promise.all([
        runAudits({
          input,
          targets: auditTargets,
          userHomepageSourceId,
          sourceIdFor: homepageSourceFor,
          signal: auditStage.signal,
          abortStage: (reason) => auditStage.abort(reason),
          deadlineAt: auditDeadlineAt,
        }),
        newsPromise,
      ]);
    } finally {
      pipeline.signal.removeEventListener("abort", abortAuditStage);
    }

    if (audits.user.audit.auditStatus === "unavailable") {
      if (pipeline.signal.aborted) throw timeoutError(pipeline.signal.reason);
      throw userSiteUnavailable(audits.user.audit);
    }

    // Listed: every audited candidate plus the nearest remaining ones, up to
    // the report cap, nearest first.
    const listed = new Set(audits.competitors.keys());
    for (const candidate of discovery.candidates) {
      if (listed.size >= MAX_COMPETITORS) break;
      listed.add(candidate.id);
    }
    const candidates = discovery.candidates.filter((candidate) =>
      listed.has(candidate.id)
    );
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

    const userMatch = discovery.userMatch;
    const userMatchSourceId = userMatch
      ? provenance.add({
          kind: "openstreetmap",
          provider: "OpenStreetMap",
          title: `${userMatch.name} map record`,
          url: userMatch.osmElementUrl,
          businessName: input.businessName,
          accessedAt: discovery.accessedAt,
          status: "used",
        })
      : undefined;
    const user = buildUserReport({
      input,
      userInputSourceId,
      homepageSourceId: userHomepageSourceId,
      provenance,
      rawAudit: audits.user,
      userMatch,
      userMatchSourceId,
      resolvedTags: discovery.resolution.tags,
    });
    const competitors = candidates.map((candidate) =>
      buildCompetitorReport({
        candidate,
        businessType: input.businessType,
        resolvedTags: discovery.resolution.tags,
        discoverySourceId,
        candidateSourceId: candidateSourceIds.get(candidate.id)!,
        homepageSourceId: candidateHomepageIds.get(candidate.id),
        provenance,
        rawAudit:
          audits.competitors.get(candidate.id) ??
          skippedAudit(
            candidate.website,
            !candidate.website
              ? "no public website listed"
              : candidate.isChain
                ? "corporate chain website"
                : "website audit not selected within bounded report capacity"
          ),
      })
    );

    const { unavailableFields: newsUnavailableFields, newsCounted } = applyNews({
      news,
      records: [user, ...competitors],
      provenance,
    });
    const ranked = rankCompetitors(user, competitors);
    const dataQuality = buildDataQuality({
      user: ranked.user,
      competitors: ranked.competitors,
      newsUnavailableFields,
      newsCounted,
      newsObserved: [ranked.user, ...ranked.competitors].some(
        (record) => record.signals.newsStatus === "complete"
      ),
      discovery,
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
      market: { label: geo.label, radiusKm: discovery.radiusKm },
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
        radiusKm: discovery.radiusKm,
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
      radiusKm: discovery.radiusKm,
      discoveryCache: discovery.cache ?? "live",
      newsStatus: news.status,
      durationMs: Date.now() - pipelineStartedAt,
    });
    return response;
  } catch (err) {
    // A stage that failed because the overall budget ran out reports the
    // timeout, not the stage's own (e.g. SOURCE_UNAVAILABLE) error.
    if (pipeline.timedOut() && !(err instanceof AnalysisTimeoutError)) {
      throw timeoutError(err);
    }
    throw err;
  } finally {
    pipeline.cleanup();
  }
}
