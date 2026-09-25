import { dedupeSourceIds } from "./provenance";
import {
  CATEGORY_LABELS,
  auditObservationSourceIds,
  classifyAuditOutcome,
  computeCategoryComparisons,
  countAuditOutcomes,
  isScored,
} from "./scoring";
import type {
  AnalyzeMarketRequest,
  BenchmarkReport,
  CompetitorHighlight,
  CompetitorReport,
  ConfidenceLevel,
  DataQuality,
  MarketSummary,
  Recommendation,
  ReportFinding,
  SourceId,
} from "./types";

const MAX_TOP_FINDINGS = 3;

function truncateWords(text: string, maxWords: number): string {
  const words = text.trim().split(/\s+/);
  return words.length <= maxWords
    ? text.trim()
    : `${words.slice(0, maxWords).join(" ")}…`;
}

/** "1 business" / "3 businesses"; never "business(es)". */
export function plural(count: number, singular: string, pluralForm?: string): string {
  return `${count} ${count === 1 ? singular : pluralForm ?? `${singular}s`}`;
}

function verb(count: number, singular: string, pluralForm: string): string {
  return count === 1 ? singular : pluralForm;
}

function listNames(names: string[], max = 3): string {
  const shown = names.slice(0, max);
  const extra = names.length - shown.length;
  if (extra > 0) return `${shown.join(", ")} and ${extra} more`;
  if (shown.length <= 1) return shown.join("");
  return `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
}

function formatKm(value: number): string {
  return value < 10 ? value.toFixed(1) : String(Math.round(value));
}

/** "0.4–12 km" over the records that carry a distance, or null. */
export function distanceRange(records: CompetitorReport[]): string | null {
  const distances = records
    .map((record) => record.distanceKm)
    .filter((value): value is number => Number.isFinite(value));
  if (distances.length === 0) return null;
  const min = Math.min(...distances);
  const max = Math.max(...distances);
  return formatKm(min) === formatKm(max)
    ? `${formatKm(min)} km`
    : `${formatKm(min)}–${formatKm(max)} km`;
}

/**
 * Comparative claims get more confident with more scored competitors. A
 * single-page homepage audit of a handful of businesses is never "high".
 */
function comparisonConfidence(
  user: CompetitorReport,
  scoredCompetitors: number
): ConfidenceLevel {
  if (scoredCompetitors >= 5 && user.auditStatus === "complete") return "high";
  if (scoredCompetitors >= 3) return "medium";
  return "low";
}

function comparisonSourceIds(
  user: CompetitorReport,
  competitors: CompetitorReport[]
): SourceId[] {
  return dedupeSourceIds([
    ...auditObservationSourceIds(user),
    ...competitors.flatMap(auditObservationSourceIds),
  ]);
}

function buildTopFindings(args: {
  input: AnalyzeMarketRequest;
  place: string;
  user: CompetitorReport;
  competitors: CompetitorReport[];
  summary: MarketSummary;
  discoverySourceIds: SourceId[];
}): ReportFinding[] {
  const { place, user, competitors, summary, discoverySourceIds } = args;
  if (user.auditStatus === "unavailable") {
    return [
      {
        title: "Your website audit was unavailable",
        finding:
          "The submitted website could not be audited, so no score or rank was produced for it.",
        evidence: `Audit outcome: ${classifyAuditOutcome(user).reason ?? "unavailable"}.`,
        implication:
          "Make sure the homepage is publicly reachable before relying on comparisons.",
        sourceIds: user.sourceIds,
        confidence: "high",
      },
    ];
  }

  const scoredCompetitors = competitors.filter(isScored);
  if (scoredCompetitors.length === 0) {
    return [
      {
        title: "No scored competitor benchmark available",
        finding:
          competitors.length === 0
            ? `No competing businesses were found near ${place}.`
            : "Discovery completed, but no competitor website audit produced a usable score.",
        evidence: `${plural(competitors.length, "business", "businesses")} ${verb(competitors.length, "was", "were")} discovered and none could be scored.`,
        implication:
          "Discovered businesses stay listed as unscored observations; no comparative claim is made.",
        sourceIds: discoverySourceIds,
        confidence: "high",
      },
    ];
  }

  const confidence = comparisonConfidence(user, scoredCompetitors.length);
  const findings: ReportFinding[] = [];
  if (
    summary.yourRank !== null &&
    summary.competitorAverageFinalScore !== null &&
    user.finalScore !== null
  ) {
    const averageFinal =
      scoredCompetitors.reduce((sum, report) => sum + report.finalScore!, 0) /
      scoredCompetitors.length;
    findings.push({
      title: "Observed market position",
      finding: `${user.rankTied ? "Tied for" : "Ranked"} #${summary.yourRank} of ${scoredCompetitors.length + 1} scored businesses near ${place}.`,
      evidence: `Your final score ${user.finalScore}/100; scored-competitor average ${summary.competitorAverageFinalScore}/100.`,
      implication:
        user.finalScore - averageFinal >= 0
          ? "Your score is at or above the scored-competitor average."
          : "Your score is below the scored-competitor average.",
      sourceIds: dedupeSourceIds([
        ...comparisonSourceIds(user, scoredCompetitors),
        ...discoverySourceIds,
      ]),
      confidence,
    });
  }

  const categoryFindings = computeCategoryComparisons(user, scoredCompetitors)
    .filter((comparison) => comparison.gap > 0.5)
    .sort((left, right) => right.gap - left.gap)
    .map<ReportFinding>((comparison) => ({
      title: `${CATEGORY_LABELS[comparison.category]} gap vs. scored competitors`,
      finding: `Your score ${comparison.userScore}/${comparison.maxScore}; scored-competitor average ${comparison.competitorAverage}/${comparison.maxScore}.`,
      evidence: `${comparison.competitorsAhead} of ${comparison.totalCompetitors} scored competitors scored higher in this category.`,
      implication: "See the recommended actions for the specific missing elements.",
      sourceIds: comparisonSourceIds(
        user,
        scoredCompetitors.filter(
          (competitor) =>
            competitor.websiteAudit.scoreBreakdown[comparison.category] !== null
        )
      ),
      confidence,
    }));
  // The market-position finding leads, so the three findings shown on screen
  // and in the PDF are the same set.
  return [...findings, ...categoryFindings].slice(0, MAX_TOP_FINDINGS);
}

function buildTopRisks(
  user: CompetitorReport,
  competitors: CompetitorReport[]
): ReportFinding[] {
  const risks: ReportFinding[] = [];
  // Defense in depth: signals are already emitted once per site, but a
  // business never shows the same label and evidence twice.
  const seen = new Set<string>();
  for (const record of [user, ...competitors]) {
    for (const signal of [
      ...record.signals.riskSignals,
      ...record.signals.changeSignals,
    ]) {
      const key = JSON.stringify([record.id, signal.label, signal.evidence]);
      if (seen.has(key)) continue;
      seen.add(key);
      risks.push({
        title: `${record.name}: ${signal.label}`,
        finding: signal.evidence,
        evidence: `Observed on ${signal.sourceUrl}.`,
        implication:
          "This is public language evidence only, not a verified internal business fact.",
        sourceIds: signal.sourceIds,
        confidence: signal.confidence,
      });
      if (risks.length === 3) return risks;
    }
  }
  return risks;
}

function buildCompetitorHighlights(
  user: CompetitorReport,
  competitors: CompetitorReport[]
): CompetitorHighlight[] {
  return competitors
    .filter(isScored)
    .slice(0, 5)
    .map((competitor) => ({
      competitorName: competitor.name,
      conciseSummary:
        user.finalScore === null
          ? `Observed score ${competitor.finalScore}/100; comparison with your business unavailable.`
          : `Observed score ${competitor.finalScore}/100 (${competitor.finalScore! - user.finalScore >= 0 ? "+" : ""}${competitor.finalScore! - user.finalScore} vs. your business).`,
      strongestVisibleSignal: [
        ...competitor.signals.momentumSignals,
        ...competitor.signals.offerSignals,
        ...competitor.signals.hiringSignals,
      ][0]?.label,
      possibleRiskSignal: [
        ...competitor.signals.riskSignals,
        ...competitor.signals.changeSignals,
      ][0]?.label,
      sourceIds: auditObservationSourceIds(competitor),
      confidence: competitor.auditStatus === "complete" ? "medium" : "low",
    }));
}

function buildPositionStatement(args: {
  input: AnalyzeMarketRequest;
  place: string;
  user: CompetitorReport;
  competitors: CompetitorReport[];
  summary: MarketSummary;
}): string {
  const { input, place, user, competitors, summary } = args;
  if (!isScored(user)) {
    return `${input.businessName} is not ranked because its website audit was unavailable.`;
  }
  const scoredCompetitors = competitors.filter(isScored);
  if (scoredCompetitors.length === 0 || summary.yourRank === null) {
    return `${input.businessName} is not ranked because no nearby competitor could be scored for comparison.`;
  }
  const range = distanceRange(scoredCompetitors);
  const placement = user.rankTied
    ? `is tied for #${summary.yourRank}`
    : `ranks #${summary.yourRank}`;
  return `${input.businessName} ${placement} of ${scoredCompetitors.length + 1} scored businesses near ${place}, with an observed score of ${user.finalScore}/100.${range ? ` The scored competitors are ${range} from the market center.` : ""}`;
}

/**
 * Human-readable data-quality summary built from the records themselves, so
 * it separates "no website listed", "audit failed" and "not audited", names
 * businesses rather than internal IDs, and never pluralizes with "(s)".
 * Also used on screen, so older stored reports read the same way.
 */
export function buildDataQualityNote(args: {
  user: CompetitorReport;
  competitors: CompetitorReport[];
  dataQuality: DataQuality;
}): string {
  const { user, competitors, dataQuality } = args;
  const outcomes = countAuditOutcomes(competitors);
  const sentences: string[] = [];
  const coverage =
    dataQuality.coverageStatus.charAt(0).toUpperCase() +
    dataQuality.coverageStatus.slice(1);
  sentences.push(`${coverage} coverage.`);

  if (competitors.length > 0) {
    const parts = [
      `${outcomes.scored} ${verb(outcomes.scored, "was", "were")} scored`,
      outcomes.noWebsite > 0 ? `${outcomes.noWebsite} had no website listed` : "",
      outcomes.auditFailed > 0
        ? `${plural(outcomes.auditFailed, "website audit")} failed`
        : "",
      outcomes.notAttempted > 0
        ? `${outcomes.notAttempted} ${verb(outcomes.notAttempted, "was", "were")} not audited because of the report's audit limit`
        : "",
      outcomes.excludedChains > 0
        ? `${outcomes.excludedChains} ${verb(outcomes.excludedChains, "was", "were")} excluded as corporate chain websites`
        : "",
    ].filter(Boolean);
    sentences.push(
      `Of ${plural(competitors.length, "nearby business", "nearby businesses")} found, ${listNames(parts, parts.length)}.`
    );
  }
  const userOutcome = classifyAuditOutcome(user);
  if (userOutcome.kind !== "scored") {
    sentences.push(`Your ${userOutcome.reason ?? "website audit was unavailable"}.`);
  }
  const limited = [user, ...competitors].filter(
    (record) => record.auditStatus === "partial"
  ).length;
  if (limited > 0) {
    sentences.push(
      `${plural(limited, "audit")} used homepage observations with limited linked-page coverage.`
    );
  }
  const newsUnavailable = [user, ...competitors]
    .filter((record) => record.signals.newsStatus === "unavailable")
    .map((record) => (record === user ? "your business" : record.name));
  if (newsUnavailable.length > 0) {
    sentences.push(
      `News search was unavailable for ${listNames(newsUnavailable)}, so news is N/A there, not zero.`
    );
  }
  if (dataQuality.unavailableFields.includes("competitorDiscovery")) {
    sentences.push(
      "Competitor discovery was limited because the business type could not be matched to OpenStreetMap categories."
    );
  }
  if (sentences.length === 1) {
    sentences.push("No required metric was unavailable.");
  }
  return sentences.join(" ");
}

export const METHODOLOGY_NOTE =
  "Scores and ranks use only successfully fetched public homepage observations, OpenStreetMap directory records and, where available, GDELT news results. An input that could not be observed for a business is N/A and is left out of that business's maximum instead of being counted as zero; this applies to your business and to competitors alike. Equal scores share a rank. Corporate chain locations are listed but not ranked.";

function buildActionPlanNote(args: {
  user: CompetitorReport;
  competitors: CompetitorReport[];
  recommendations: Recommendation[];
}): string | undefined {
  if (args.recommendations.length > 0) return undefined;
  if (!isScored(args.user)) {
    return "No action plan: your website audit was unavailable, so there is no observed evidence to act on.";
  }
  if (!args.competitors.some(isScored)) {
    return "No action plan: no nearby competitor could be scored for comparison.";
  }
  return "No material gaps found: your homepage audit showed every element this report checks.";
}

export function generateBenchmarkReport(args: {
  input: AnalyzeMarketRequest;
  user: CompetitorReport;
  competitors: CompetitorReport[];
  summary: MarketSummary;
  recommendations: Recommendation[];
  dataQuality: DataQuality;
  discoverySourceIds: SourceId[];
  /**
   * The market as resolved by geocoding. Prose names the resolved place and
   * the search radius actually used, not the user's typed string.
   */
  market?: { label: string; radiusKm?: number };
}): BenchmarkReport {
  const {
    input,
    user,
    competitors,
    summary,
    recommendations,
    dataQuality,
    discoverySourceIds,
  } = args;
  const place = args.market?.label ?? input.market;
  const radiusKm = args.market?.radiusKm;
  const positionStatement = buildPositionStatement({
    input,
    place,
    user,
    competitors,
    summary,
  });
  const listedCount = competitors.length;
  // The listed set is capped; the discovered count (when recorded) is the
  // real number of businesses OpenStreetMap returned within the radius.
  const found = Math.max(dataQuality.discoveredCount ?? listedCount, listedCount);
  const foundPrefix = found > listedCount && dataQuality.discoveryTruncated ? "at least " : "";
  const scoredCount = competitors.filter(isScored).length;
  const foundRange = distanceRange(competitors);
  const listedClause =
    found > listedCount
      ? `; the ${plural(listedCount, "business", "businesses")} listed here ${verb(listedCount, "is", "are")} ${foundRange ? `${foundRange} from the market center` : "the audited and nearest ones"}`
      : foundRange
        ? `, ${foundRange} from the market center`
        : "";
  const executiveSummary = truncateWords(
    `Benchmark Scout found ${foundPrefix}${plural(found, "business", "businesses")} of this type ${radiusKm !== undefined ? `within ${radiusKm} km of` : "near"} ${place} in OpenStreetMap${listedClause}. ${scoredCount} ${verb(scoredCount, "was", "were")} scored from a successful website audit. ${positionStatement} Unavailable observations are shown as N/A, not converted to zero.`,
    120
  );
  const actionPlanNote = buildActionPlanNote({ user, competitors, recommendations });

  return {
    title: `Benchmark Scout Report — ${input.businessName} (${input.market})`,
    executiveSummary,
    positionStatement,
    topFindings: buildTopFindings({
      input,
      place,
      user,
      competitors,
      summary,
      discoverySourceIds,
    }),
    topRisks: buildTopRisks(user, competitors),
    competitorHighlights: buildCompetitorHighlights(user, competitors),
    actionPlan: recommendations,
    ...(actionPlanNote ? { actionPlanNote } : {}),
    methodologyNote: METHODOLOGY_NOTE,
    dataQualityNote: truncateWords(
      buildDataQualityNote({ user, competitors, dataQuality }),
      110
    ),
  };
}
