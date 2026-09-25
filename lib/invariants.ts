import {
  CATEGORY_MAX_SCORES,
  computeFinalScore,
  countAuditOutcomes,
  statusForPosition,
  type CategoryKey,
} from "./scoring";
import type { AnalyzeMarketResponse, CompetitorReport, SourceId } from "./types";

export class RealDataInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RealDataInvariantError";
  }
}

function fail(message: string): never {
  throw new RealDataInvariantError(message);
}

function assertSourceIds(
  label: string,
  sourceIds: readonly SourceId[] | undefined,
  knownIds: Set<string>,
  required = true
): void {
  if (!sourceIds) fail(`${label} is missing sourceIds.`);
  if (required && sourceIds.length === 0) fail(`${label} has no sourceIds.`);
  if (new Set(sourceIds).size !== sourceIds.length) {
    fail(`${label} contains duplicate sourceIds.`);
  }
  for (const sourceId of sourceIds) {
    if (!knownIds.has(sourceId)) {
      fail(`${label} references unresolved source ID ${sourceId}.`);
    }
  }
}

function rejectSyntheticOrLegacyValues(value: unknown, path = "response"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      rejectSyntheticOrLegacyValues(item, `${path}[${index}]`)
    );
    return;
  }
  if (!value || typeof value !== "object") return;

  for (const [key, child] of Object.entries(value)) {
    if (key === "demoMode" || key === "usedMockData" || /uplift/i.test(key)) {
      fail(`${path}.${key} is a forbidden legacy or modeled field.`);
    }
    if (
      ["source", "sourceType", "provider", "policy"].includes(key) &&
      typeof child === "string" &&
      /mock|demo|synthetic/i.test(child)
    ) {
      fail(`${path}.${key} contains forbidden synthetic source value.`);
    }
    rejectSyntheticOrLegacyValues(child, `${path}.${key}`);
  }
}

function assertFiniteScore(
  label: string,
  value: number | null,
  required: boolean
): void {
  if (value === null) {
    if (required) fail(`${label} must be a real observed score.`);
    return;
  }
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    fail(`${label} must be a finite score from 0 to 100.`);
  }
}

/** Scoring v1 (reports stored before summary.scoringVersion existed). */
function expectedStatus(score: number): NonNullable<AnalyzeMarketResponse["summary"]["status"]> {
  if (score >= 80) return "leading";
  if (score >= 65) return "competitive";
  if (score >= 45) return "behind but recoverable";
  return "low visibility";
}

const UNAVAILABLE_AUDIT_FIELDS = [
  "h1Count",
  "headingCount",
  "wordCount",
  "ctaCount",
  "hasPhone",
  "hasEmail",
  "hasContactPage",
  "hasBookingOrQuote",
  "hasPricingPage",
  "hasServicesPage",
  "hasAboutOrTeamPage",
  "hasBlogOrNewsPage",
  "hasCareersPage",
  "hasTestimonials",
  "hasTrustLanguage",
  "hasGalleryOrCaseStudy",
  "hasSocialLinks",
  "hasViewport",
  "isHttps",
  "htmlBytes",
  "fetchMs",
  "websiteScore",
] as const;

/**
 * Score arithmetic and bounds that hold for every scoring version: each
 * category is within its maximum, the website score is the category sum, and
 * the final score is the published weighting of its components.
 */
function assertScoreArithmetic(record: CompetitorReport): void {
  const label = `competitor ${record.id}`;
  const breakdown = record.websiteAudit.scoreBreakdown;
  if (record.auditStatus !== "unavailable") {
    let sum = 0;
    for (const [key, value] of Object.entries(breakdown)) {
      const max = CATEGORY_MAX_SCORES[key as CategoryKey];
      if (max === undefined) fail(`${label} scoreBreakdown.${key} is not a known category.`);
      if (value! > max) {
        fail(`${label} scoreBreakdown.${key} exceeds its maximum of ${max}.`);
      }
      sum += value!;
    }
    if (record.websiteAudit.websiteScore !== sum) {
      fail(`${label} websiteScore does not equal its category sum.`);
    }
  }
  if (record.finalScore !== null) {
    const expected = computeFinalScore({
      websiteScore: record.websiteAudit.websiteScore,
      localPresenceScore: record.localPresenceScore,
      momentumScore: record.signals.momentumScore,
      riskScore: record.signals.riskScore,
    });
    if (expected !== record.finalScore) {
      fail(`${label} finalScore does not match its component scores.`);
    }
  }
}

function canonicalUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      fail(`Invalid provenance URL protocol: ${url}.`);
    }
    parsed.hash = "";
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.pathname = parsed.pathname.replace(/\/$/, "") || "/";
    return parsed.toString();
  } catch {
    fail(`Invalid provenance URL: ${url}.`);
  }
}

export function assertRealDataResponse(response: AnalyzeMarketResponse): void {
  if (response.schemaVersion !== 2) fail("schemaVersion must be 2.");
  if (response.provenance.policy !== "real-only") {
    fail("provenance policy must be real-only.");
  }
  if (response.provenance.containsSyntheticData !== false) {
    fail("containsSyntheticData must be false.");
  }
  if (response.provenance.sources.length === 0) {
    fail("provenance.sources must not be empty.");
  }

  const knownIds = new Set<string>();
  const sourceKeys = new Set<string>();
  const sourceUrls = new Set<string>();
  const allowedKinds = new Set([
    "user_input",
    "nominatim",
    "openstreetmap",
    "homepage",
    "linked_page",
    "news_article",
  ]);
  response.provenance.sources.forEach((source, index) => {
    const expectedId = `S${index + 1}`;
    if (source.id !== expectedId) {
      fail(`provenance source IDs must be stable and sequential; expected ${expectedId}.`);
    }
    if (knownIds.has(source.id)) fail(`Duplicate provenance ID ${source.id}.`);
    knownIds.add(source.id);
    if (!source.provider.trim()) fail(`${source.id} has no provider.`);
    if (!source.title.trim()) fail(`${source.id} has no title.`);
    if (!allowedKinds.has(source.kind)) fail(`${source.id} has an invalid kind.`);
    if (
      typeof source.accessedAt !== "string" ||
      Number.isNaN(Date.parse(source.accessedAt))
    ) {
      fail(`${source.id} has an invalid accessedAt timestamp.`);
    }
    if (!["used", "limited", "unavailable"].includes(source.status)) {
      fail(`${source.id} has an invalid status.`);
    }
    if (
      ["homepage", "linked_page", "news_article"].includes(source.kind) &&
      !source.url
    ) {
      fail(`${source.id} kind ${source.kind} requires a URL.`);
    }
    const normalizedUrl = source.url ? canonicalUrl(source.url) : "";
    if (normalizedUrl && sourceUrls.has(normalizedUrl)) {
      fail(`${source.id} duplicates a canonical provenance URL.`);
    }
    if (normalizedUrl) sourceUrls.add(normalizedUrl);
    const sourceKey = [
      source.kind,
      source.provider,
      normalizedUrl,
      source.title.trim().toLowerCase(),
      source.businessName?.trim().toLowerCase() ?? "",
    ].join("|");
    if (sourceKeys.has(sourceKey)) fail(`Duplicate provenance source ${source.id}.`);
    sourceKeys.add(sourceKey);
  });

  assertSourceIds("market", response.market.sourceIds, knownIds);
  if (
    !Number.isFinite(response.market.lat) ||
    response.market.lat < -90 ||
    response.market.lat > 90 ||
    !Number.isFinite(response.market.lon) ||
    response.market.lon < -180 ||
    response.market.lon > 180
  ) {
    fail("market coordinates must be finite real coordinates.");
  }
  if (
    response.summary.scoringVersion !== undefined &&
    response.summary.scoringVersion !== 2
  ) {
    fail("summary.scoringVersion is not a supported scoring version.");
  }
  // v2 reports use shared tie ranks, leave a lone scored entity unranked,
  // exclude chain locations, and derive status from position. Reports stored
  // before v2 keep being validated against the v1 rules they were built with.
  const scoringV2 = response.summary.scoringVersion === 2;
  const records = [response.user, ...response.competitors];
  for (const record of records) {
    assertSourceIds(`competitor ${record.id}`, record.sourceIds, knownIds);
    assertSourceIds(
      `website audit ${record.id}`,
      record.websiteAudit.sourceIds,
      knownIds,
      record.auditStatus !== "unavailable"
    );
    assertSourceIds(
      `signal scan ${record.id}`,
      record.signals.sourceIds,
      knownIds,
      record.signals.auditStatus !== "unavailable"
    );
    if (
      record.websiteAudit.auditStatus !== record.auditStatus ||
      record.signals.auditStatus !== record.auditStatus
    ) {
      fail(`competitor ${record.id} has inconsistent audit states.`);
    }
    const auditAvailable = record.auditStatus !== "unavailable";
    assertFiniteScore(
      `competitor ${record.id} categoryMatchScore`,
      record.categoryMatchScore,
      false
    );
    assertFiniteScore(
      `competitor ${record.id} localPresenceScore`,
      record.localPresenceScore,
      false
    );
    assertFiniteScore(
      `competitor ${record.id} websiteScore`,
      record.websiteAudit.websiteScore,
      auditAvailable
    );
    for (const [key, value] of Object.entries(record.websiteAudit.scoreBreakdown)) {
      if (auditAvailable) {
        if (!Number.isFinite(value) || value! < 0) {
          fail(`competitor ${record.id} scoreBreakdown.${key} is invalid.`);
        }
      } else if (value !== null) {
        fail(`competitor ${record.id} scoreBreakdown.${key} must be null when unavailable.`);
      }
    }
    assertFiniteScore(
      `competitor ${record.id} momentumScore`,
      record.signals.momentumScore,
      auditAvailable
    );
    assertFiniteScore(
      `competitor ${record.id} riskScore`,
      record.signals.riskScore,
      auditAvailable
    );
    assertFiniteScore(
      `competitor ${record.id} changeScore`,
      record.signals.changeScore,
      auditAvailable
    );
    const excludedChain = scoringV2 && record.isChain === true;
    assertFiniteScore(
      `competitor ${record.id} finalScore`,
      record.finalScore,
      auditAvailable && !excludedChain
    );
    assertScoreArithmetic(record);
    if (excludedChain && (record.finalScore !== null || record.rank !== null)) {
      fail(`competitor ${record.id} is a chain location and must stay unscored.`);
    }
    if (!auditAvailable) {
      if (!record.websiteAudit.skipped) {
        fail(`competitor ${record.id} unavailable audit must be marked skipped.`);
      }
      for (const field of UNAVAILABLE_AUDIT_FIELDS) {
        if (record.websiteAudit[field] !== null) {
          fail(`competitor ${record.id} websiteAudit.${field} must be null when unavailable.`);
        }
      }
      if (record.rank !== null) {
        fail(`competitor ${record.id} rank must be null when unavailable.`);
      }
    } else if (
      !scoringV2 &&
      (!Number.isInteger(record.rank) || record.rank! < 1)
    ) {
      fail(`competitor ${record.id} must have a positive observed rank.`);
    }
    for (const evidence of record.websiteAudit.evidence) {
      assertSourceIds(`audit evidence for ${record.id}`, evidence.sourceIds, knownIds);
    }
    for (const signal of [
      ...record.signals.momentumSignals,
      ...record.signals.riskSignals,
      ...record.signals.changeSignals,
      ...record.signals.offerSignals,
      ...record.signals.hiringSignals,
      ...record.signals.newsSignals,
    ]) {
      assertSourceIds(`signal for ${record.id}`, signal.sourceIds, knownIds);
    }
  }

  for (const finding of [
    ...response.report.topFindings,
    ...response.report.topRisks,
  ]) {
    assertSourceIds(`report finding ${finding.title}`, finding.sourceIds, knownIds);
  }
  for (const highlight of response.report.competitorHighlights) {
    assertSourceIds(
      `competitor highlight ${highlight.competitorName}`,
      highlight.sourceIds,
      knownIds
    );
  }
  for (const recommendation of [
    ...response.recommendations,
    ...response.report.actionPlan,
  ]) {
    assertSourceIds(
      `recommendation ${recommendation.title}`,
      recommendation.sourceIds,
      knownIds
    );
  }

  const scoredRecords = records.filter((record) => record.finalScore !== null);
  if (scoringV2) {
    // Competition ranking: rank = 1 + number of strictly higher scores, equal
    // scores share a rank and are flagged as tied. A lone scored entity has
    // nothing to be ranked against and stays unranked.
    for (const record of scoredRecords) {
      const tied = scoredRecords.some(
        (other) => other !== record && other.finalScore === record.finalScore
      );
      const expectedRank =
        scoredRecords.length < 2
          ? null
          : 1 +
            scoredRecords.filter(
              (other) => other.finalScore! > record.finalScore!
            ).length;
      if (record.rank !== expectedRank) {
        fail(`competitor ${record.id} rank is inconsistent with the observed scores.`);
      }
      if ((record.rankTied === true) !== (expectedRank !== null && tied)) {
        fail(`competitor ${record.id} rankTied does not match the observed scores.`);
      }
    }
    if (
      (response.summary.yourRankTied === true) !==
      (response.user.rankTied === true)
    ) {
      fail("summary.yourRankTied does not match the user record.");
    }
  } else {
    const ranked = [...scoredRecords].sort(
      (left, right) => left.rank! - right.rank!
    );
    ranked.forEach((record, index) => {
      if (record.rank !== index + 1) {
        fail("Observed ranks must be unique and contiguous.");
      }
      if (index > 0 && record.finalScore! > ranked[index - 1].finalScore!) {
        fail("Observed ranks must be ordered by final score.");
      }
    });
  }
  if (response.summary.competitorCount !== response.competitors.length) {
    fail("summary.competitorCount does not match the real competitor records.");
  }
  const scoredCompetitors = response.competitors.filter(
    (record) => record.finalScore !== null
  );
  if (response.summary.auditedCompetitorCount !== scoredCompetitors.length) {
    fail("summary.auditedCompetitorCount does not match scored competitors.");
  }
  if (
    response.dataQuality.realCompetitorsFound !== response.competitors.length ||
    response.dataQuality.scoredCompetitors !== scoredCompetitors.length
  ) {
    fail("dataQuality competitor coverage does not match the report records.");
  }
  const failedAudits = records.filter(
    (record) => record.auditStatus === "unavailable"
  ).length;
  const limitedAudits = records.filter(
    (record) => record.auditStatus === "partial"
  ).length;
  if (
    response.dataQuality.failedAudits !== failedAudits ||
    response.dataQuality.limitedAudits !== limitedAudits
  ) {
    fail("dataQuality audit counts do not match the report records.");
  }
  if (response.summary.yourRank !== response.user.rank) {
    fail("summary.yourRank does not match the user record rank.");
  }
  const averageWebsite = scoredCompetitors.length
    ? Math.round(
        scoredCompetitors.reduce(
          (sum, record) => sum + record.websiteAudit.websiteScore!,
          0
        ) / scoredCompetitors.length
      )
    : null;
  const rawAverageFinal = scoredCompetitors.length
    ? scoredCompetitors.reduce((sum, record) => sum + record.finalScore!, 0) /
      scoredCompetitors.length
    : null;
  const averageFinal = rawAverageFinal === null ? null : Math.round(rawAverageFinal);
  if (
    response.summary.competitorAverageWebsiteScore !== averageWebsite ||
    response.summary.competitorAverageFinalScore !== averageFinal
  ) {
    fail("summary competitor averages do not match scored competitors.");
  }
  const expectedGap =
    response.user.finalScore === null || rawAverageFinal === null
      ? null
      : Math.round(response.user.finalScore - rawAverageFinal);
  if (response.summary.marketGap !== expectedGap) {
    fail("summary.marketGap does not match observed scores.");
  }
  const expectedUserStatus = scoringV2
    ? statusForPosition({
        rank: response.user.rank,
        gap:
          response.user.finalScore === null || rawAverageFinal === null
            ? null
            : response.user.finalScore - rawAverageFinal,
      })
    : response.user.finalScore === null
      ? null
      : expectedStatus(response.user.finalScore);
  if (response.summary.status !== expectedUserStatus) {
    fail(
      scoringV2
        ? "summary.status does not match the user's observed rank and market gap."
        : "summary.status does not match the observed user score."
    );
  }
  if (response.dataQuality.auditOutcomes) {
    const expectedOutcomes = countAuditOutcomes(response.competitors);
    for (const [key, value] of Object.entries(expectedOutcomes)) {
      if (
        response.dataQuality.auditOutcomes[
          key as keyof typeof expectedOutcomes
        ] !== value
      ) {
        fail(`dataQuality.auditOutcomes.${key} does not match the report records.`);
      }
    }
  }
  if (response.user.finalScore === null && response.competitors.length === 0) {
    fail("response contains no usable real entity evidence.");
  }
  if (!Number.isFinite(Date.parse(response.generatedAt))) {
    fail("generatedAt must be a valid timestamp.");
  }

  rejectSyntheticOrLegacyValues(response);
}
