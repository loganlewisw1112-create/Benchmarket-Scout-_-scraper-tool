import { dedupeSourceIds } from "./provenance";
import {
  CATEGORY_LABELS,
  computeCategoryComparisons,
  isScored,
} from "./scoring";
import type {
  AnalyzeMarketRequest,
  BenchmarkReport,
  CompetitorHighlight,
  CompetitorReport,
  DataQuality,
  MarketSummary,
  Recommendation,
  ReportFinding,
  SourceId,
} from "./types";

function truncateWords(text: string, maxWords: number): string {
  const words = text.trim().split(/\s+/);
  return words.length <= maxWords
    ? text.trim()
    : `${words.slice(0, maxWords).join(" ")}…`;
}

function recordSourceIds(
  user: CompetitorReport,
  competitors: CompetitorReport[]
): SourceId[] {
  return dedupeSourceIds([
    ...user.sourceIds,
    ...competitors.flatMap((competitor) => competitor.sourceIds),
  ]);
}

function buildTopFindings(args: {
  user: CompetitorReport;
  competitors: CompetitorReport[];
  summary: MarketSummary;
  discoverySourceIds: SourceId[];
}): ReportFinding[] {
  const { user, competitors, summary, discoverySourceIds } = args;
  if (user.auditStatus === "unavailable") {
    return [
      {
        title: "User website audit unavailable",
        finding: "The submitted website could not be audited, so no user score or rank was produced.",
        evidence: user.websiteAudit.reason ?? "Homepage audit was unavailable.",
        implication: "Resolve website accessibility before using comparative recommendations.",
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
          "Discovery completed, but no competitor homepage audit produced a usable score.",
        evidence: `${competitors.length} real business record(s) were discovered and 0 were scoreable.`,
        implication:
          "The discovered businesses remain listed as unscored observations; no comparative claim is made.",
        sourceIds: discoverySourceIds,
        confidence: "high",
      },
    ];
  }

  const sourceIds = recordSourceIds(user, scoredCompetitors);
  const findings = computeCategoryComparisons(user, scoredCompetitors)
    .filter((comparison) => comparison.gap > 0.5)
    .sort((left, right) => right.gap - left.gap)
    .slice(0, 3)
    .map<ReportFinding>((comparison) => ({
      title: `${CATEGORY_LABELS[comparison.category]} gap vs. audited competitors`,
      finding: `User score ${comparison.userScore}/${comparison.maxScore}; audited-competitor average ${comparison.competitorAverage}/${comparison.maxScore}.`,
      evidence: `${comparison.competitorsAhead} of ${comparison.totalCompetitors} successfully audited competitors scored higher in this observed category.`,
      implication: "Address the observed elements behind this category gap.",
      sourceIds,
      confidence: user.auditStatus === "complete" ? "high" : "medium",
    }));

  if (
    summary.yourRank !== null &&
    summary.competitorAverageFinalScore !== null &&
    user.finalScore !== null
  ) {
    findings.push({
      title: "Observed market position",
      finding: `Rank #${summary.yourRank} among ${summary.auditedCompetitorCount + 1} successfully audited businesses.`,
      evidence: `User final score ${user.finalScore}/100; audited-competitor average ${summary.competitorAverageFinalScore}/100.`,
      implication:
        summary.marketGap !== null && summary.marketGap >= 0
          ? "The user score is at or above the observed competitor average."
          : "The user score is below the observed competitor average.",
      sourceIds,
      confidence: "high",
    });
  }
  return findings.slice(0, 5);
}

function buildTopRisks(
  user: CompetitorReport,
  competitors: CompetitorReport[]
): ReportFinding[] {
  const risks: ReportFinding[] = [];
  for (const record of [user, ...competitors]) {
    for (const signal of [
      ...record.signals.riskSignals,
      ...record.signals.changeSignals,
    ]) {
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
          ? `Observed score ${competitor.finalScore}/100; user comparison unavailable.`
          : `Observed score ${competitor.finalScore}/100 (${competitor.finalScore! - user.finalScore >= 0 ? "+" : ""}${competitor.finalScore! - user.finalScore} vs. user).`,
      strongestVisibleSignal: [
        ...competitor.signals.momentumSignals,
        ...competitor.signals.offerSignals,
        ...competitor.signals.hiringSignals,
      ][0]?.label,
      possibleRiskSignal: [
        ...competitor.signals.riskSignals,
        ...competitor.signals.changeSignals,
      ][0]?.label,
      sourceIds: competitor.sourceIds,
      confidence: competitor.auditStatus === "complete" ? "high" : "medium",
    }));
}

export function generateBenchmarkReport(args: {
  input: AnalyzeMarketRequest;
  user: CompetitorReport;
  competitors: CompetitorReport[];
  summary: MarketSummary;
  recommendations: Recommendation[];
  dataQuality: DataQuality;
  discoverySourceIds: SourceId[];
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
  const scoredTotal = summary.auditedCompetitorCount + (isScored(user) ? 1 : 0);
  const positionStatement =
    summary.yourRank === null || user.finalScore === null
      ? `${input.businessName} is unranked because its website audit was unavailable.`
      : `${input.businessName} ranks #${summary.yourRank} among ${scoredTotal} successfully audited businesses in ${input.market}, with an observed score of ${user.finalScore}/100.`;
  const executiveSummary = truncateWords(
    `Benchmark Scout found ${dataQuality.realCompetitorsFound} real competitor record(s) in ${input.market}; ${dataQuality.scoredCompetitors} had successful website audits and were eligible for ranking. ${positionStatement} Unavailable observations remain N/A and are not converted to zeroes.`,
    120
  );
  const dataQualityNote = truncateWords(
    `${dataQuality.coverageStatus} coverage: ${dataQuality.failedAudits} failed audit(s), ${dataQuality.limitedAudits} limited audit(s). ${dataQuality.unavailableFields.length ? `Unavailable: ${dataQuality.unavailableFields.join(", ")}.` : "No required metric fields were unavailable."} ${dataQuality.notes.join(" ")}`,
    90
  );

  return {
    title: `Benchmark Scout Report — ${input.businessName} (${input.market})`,
    executiveSummary,
    positionStatement,
    topFindings: buildTopFindings({
      user,
      competitors,
      summary,
      discoverySourceIds,
    }),
    topRisks: buildTopRisks(user, competitors),
    competitorHighlights: buildCompetitorHighlights(user, competitors),
    actionPlan: recommendations,
    methodologyNote:
      "Scores and ranks use only successfully fetched public website observations plus real directory and public-signal data. Unavailable fields remain N/A; unobserved businesses and metrics are not added or estimated.",
    dataQualityNote,
  };
}
