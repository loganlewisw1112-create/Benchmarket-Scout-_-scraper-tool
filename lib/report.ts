import {
  CATEGORY_LABELS,
  adoptionStatForCategory,
  computeAdoptionStats,
  computeCategoryComparisons,
  simulateCategoryUplift,
  type CategoryComparison,
} from "./scoring";
import type {
  AnalyzeMarketRequest,
  AnalyzeMarketResponse,
  BenchmarkReport,
  CompetitorHighlight,
  CompetitorReport,
  ConfidenceLevel,
  MarketSummary,
  Recommendation,
  ReportFinding,
} from "./types";

function truncateWords(text: string, maxWords: number): string {
  const words = text.trim().split(/\s+/);
  if (words.length <= maxWords) return text.trim();
  return `${words.slice(0, maxWords).join(" ")}…`;
}

function homepageConfidence(competitor: CompetitorReport): ConfidenceLevel {
  if (competitor.source === "mock") return "low";
  if (competitor.websiteAudit.skipped) return "low";
  return "high";
}

function strongestSignalLabel(competitor: CompetitorReport): string | undefined {
  const { signals } = competitor;
  const pools = [
    ...signals.momentumSignals,
    ...signals.offerSignals,
    ...signals.hiringSignals,
  ];
  return pools[0]?.label;
}

function riskSignalLabel(competitor: CompetitorReport): string | undefined {
  const pools = [...competitor.signals.riskSignals, ...competitor.signals.changeSignals];
  return pools[0]?.label;
}

function biggestDifferentiator(
  user: CompetitorReport,
  competitor: CompetitorReport
): { label: string; theirScore: number; yourScore: number } | undefined {
  const categories = Object.keys(CATEGORY_LABELS) as (keyof typeof CATEGORY_LABELS)[];
  const deltas = categories.map((category) => ({
    category,
    delta:
      competitor.websiteAudit.scoreBreakdown[category] -
      user.websiteAudit.scoreBreakdown[category],
  }));
  const top = deltas.sort((a, b) => b.delta - a.delta)[0];
  if (!top || top.delta <= 0) return undefined;
  return {
    label: CATEGORY_LABELS[top.category],
    theirScore: competitor.websiteAudit.scoreBreakdown[top.category],
    yourScore: user.websiteAudit.scoreBreakdown[top.category],
  };
}

function buildTopFindings(
  user: CompetitorReport,
  competitors: CompetitorReport[],
  summary: MarketSummary
): ReportFinding[] {
  const userConfidence = homepageConfidence(user);

  if (competitors.length === 0) {
    return [
      {
        title: "Limited market comparison available",
        finding:
          "No live or fallback competitor rows were available for category-by-category comparison in this run.",
        evidence: "No competitor rows were returned by discovery.",
        implication:
          "Re-run the analysis, or switch to auto/mock demo mode, to see a full comparative benchmark.",
        confidence: "low",
      },
    ];
  }

  const findings: ReportFinding[] = [];
  const comparisons = computeCategoryComparisons(user, competitors);
  const adoptionStats = computeAdoptionStats(user, competitors);
  const gaps = [...comparisons]
    .filter((c) => c.gap > 0.5)
    .sort((a, b) => b.gap - a.gap);

  function describeGap(
    comparison: CategoryComparison,
    includeProjection: boolean
  ): ReportFinding {
    const label = CATEGORY_LABELS[comparison.category];
    const adoption = adoptionStatForCategory(comparison.category, adoptionStats);
    const adoptionSentence =
      adoption && !adoption.userHasIt
        ? ` ${adoption.competitorAdoptionCount} of ${adoption.totalCompetitors} tracked competitors show ${adoption.label}; your homepage does not.`
        : "";

    let implication = `Closing this gap is one of the more direct ways to move up the local ranking.`;

    if (includeProjection) {
      const uplift = simulateCategoryUplift(user, competitors, comparison.category);
      if (uplift && uplift.projectedRank < uplift.currentRank) {
        implication = `Directional projection: matching the market average here alone would raise your final score from ${user.finalScore} to roughly ${uplift.projectedFinalScore}, a modeled move from rank #${uplift.currentRank} to #${uplift.projectedRank}. This is a formula projection, not a guarantee.`;
      } else if (uplift) {
        implication = `Directional projection: matching the market average here would raise your final score from ${user.finalScore} to roughly ${uplift.projectedFinalScore}. This is a formula projection, not a guarantee.`;
      }
    }

    return {
      title: `${label} gap vs. market average`,
      finding: `You score ${comparison.userScore}/${comparison.maxScore} on ${label}, versus a market average of ${comparison.competitorAverage}/${comparison.maxScore} — ${comparison.competitorsAhead} of ${comparison.totalCompetitors} tracked competitors score higher here.${adoptionSentence}`,
      evidence: user.websiteAudit.skipped
        ? "Limited audit: homepage could not be fully fetched."
        : `Observed directly on ${user.website ?? "your homepage"}; compared against public homepage audits of tracked competitors.`,
      implication,
      confidence: userConfidence,
    };
  }

  if (gaps[0]) findings.push(describeGap(gaps[0], true));
  if (gaps[1]) findings.push(describeGap(gaps[1], false));

  const categoriesBehind = comparisons.filter((c) => c.gap > 0.5).length;
  findings.push({
    title: "Local market position",
    finding: `You rank #${summary.yourRank} of ${summary.competitorCount + 1} tracked businesses with a final score of ${user.finalScore}/100, versus a competitor average of ${summary.competitorAverageFinalScore}/100. You trail the market average in ${categoriesBehind} of 5 audited website categories.`,
    evidence: "Directional benchmark computed from public website audits and local presence signals.",
    implication:
      summary.marketGap >= 0
        ? "You currently lead the tracked market average on a blended basis."
        : "There is measurable, quantified room to close the gap with the local average.",
    confidence: "medium",
  });

  const momentumAdoption = adoptionStats.find((s) => s.key === "momentum");
  if (momentumAdoption) {
    const userMomentumCount =
      user.signals.momentumSignals.length +
      user.signals.offerSignals.length +
      user.signals.hiringSignals.length;
    findings.push({
      title: "Market-wide momentum signal adoption",
      finding: `${momentumAdoption.competitorAdoptionCount} of ${momentumAdoption.totalCompetitors} tracked competitors show public momentum, hiring, or offer language on their homepage; your public pages show ${userMomentumCount} such signal(s).`,
      evidence: "Aggregated from homepage and linked-page keyword scans across all tracked businesses.",
      implication:
        userMomentumCount === 0
          ? "Publicizing even one concrete update (a new offer, hire, or milestone) would bring you in line with the visible market norm."
          : "Your public momentum signals are broadly in line with what the local market is showing.",
      confidence: "medium",
    });
  }

  if (summary.strongestCompetitor) {
    const strongest = competitors.find((c) => c.name === summary.strongestCompetitor);
    const diff = strongest ? biggestDifferentiator(user, strongest) : undefined;
    findings.push({
      title: "Strongest tracked competitor",
      finding: `${summary.strongestCompetitor} currently shows the strongest combined public score in this market (${strongest?.finalScore ?? "—"}/100 vs. your ${user.finalScore}/100).${diff ? ` The largest gap is in ${diff.label} (${diff.theirScore} vs. your ${diff.yourScore}).` : ""}`,
      evidence:
        strongest?.source === "mock"
          ? "Fallback demo row — not a live public observation."
          : "Directional benchmark based on public website audit and local presence signals.",
      implication: "Worth reviewing their public homepage for structural differences worth adapting.",
      confidence: strongest ? homepageConfidence(strongest) : "low",
    });
  }

  return findings.slice(0, 5);
}

function buildTopRisks(
  user: CompetitorReport,
  competitors: CompetitorReport[]
): ReportFinding[] {
  const risks: ReportFinding[] = [];

  const allWithSignals = [user, ...competitors];
  for (const c of allWithSignals) {
    for (const signal of [...c.signals.riskSignals, ...c.signals.changeSignals]) {
      if (risks.length >= 3) break;
      risks.push({
        title: `${c.name}: ${signal.label}`,
        finding: signal.evidence,
        evidence:
          c.source === "mock"
            ? "Fallback demo row — not a live public observation."
            : `Public signal observed on ${signal.sourceUrl ?? c.website ?? "public page"}.`,
        implication:
          "This is a possible signal only, not a confirmed internal company fact.",
        confidence: c.source === "mock" ? "low" : signal.confidence,
      });
    }
    if (risks.length >= 3) break;
  }

  return risks.slice(0, 3);
}

function buildCompetitorHighlights(
  user: CompetitorReport,
  competitors: CompetitorReport[]
): CompetitorHighlight[] {
  return [...competitors]
    .sort((a, b) => b.finalScore - a.finalScore)
    .slice(0, 5)
    .map((c) => {
      const delta = c.finalScore - user.finalScore;
      const deltaText = `${delta >= 0 ? "+" : ""}${delta} vs. your ${user.finalScore}`;
      const diff = biggestDifferentiator(user, c);

      const conciseSummary =
        c.source === "mock"
          ? `Fallback demo row. Directional score ${c.finalScore}/100 (${deltaText}) based on labeled sample data.`
          : `Scores ${c.finalScore}/100 overall (${deltaText}).${diff ? ` Largest edge: ${diff.label} (${diff.theirScore} vs. your ${diff.yourScore}).` : ""}`;

      return {
        competitorName: c.name,
        conciseSummary,
        strongestVisibleSignal: strongestSignalLabel(c),
        possibleRiskSignal: riskSignalLabel(c),
        confidence: homepageConfidence(c),
      };
    });
}

export function generateBenchmarkReport(args: {
  input: AnalyzeMarketRequest;
  user: CompetitorReport;
  competitors: CompetitorReport[];
  summary: MarketSummary;
  recommendations: Recommendation[];
  dataQuality: AnalyzeMarketResponse["dataQuality"];
}): BenchmarkReport {
  const { input, user, competitors, summary, recommendations, dataQuality } = args;

  const categoriesBehind =
    competitors.length > 0
      ? computeCategoryComparisons(user, competitors).filter((c) => c.gap > 0.5).length
      : 0;

  const positionStatement = truncateWords(
    `${input.businessName} ranks #${summary.yourRank} of ${summary.competitorCount + 1} in ${input.market} (status: ${summary.status}), gap ${summary.marketGap >= 0 ? "+" : ""}${summary.marketGap} pts vs. average, trailing on ${categoriesBehind}/5 site categories.`,
    40
  );

  const topGapSentence = (() => {
    if (competitors.length === 0) return "";
    const [topGap] = [...computeCategoryComparisons(user, competitors)]
      .filter((c) => c.gap > 0.5)
      .sort((a, b) => b.gap - a.gap);
    if (!topGap) return "Your website audit is at or above the local market average across all tracked categories. ";
    return `The single largest lever is ${CATEGORY_LABELS[topGap.category]}, where you trail the market average by ${topGap.gap} points (${topGap.competitorsAhead} of ${topGap.totalCompetitors} competitors score higher). `;
  })();

  const executiveSummary = truncateWords(
    `Benchmark Scout analyzed ${input.businessName} against ${summary.competitorCount} local ${input.businessType} competitors in ${input.market} using public web signals. ` +
      `${input.businessName} currently ranks #${summary.yourRank} of ${summary.competitorCount + 1} with a final score of ${user.finalScore}/100, compared to a market average of ${summary.competitorAverageFinalScore}/100 (${summary.marketGap >= 0 ? "+" : ""}${summary.marketGap} pt gap). ` +
      `${topGapSentence}` +
      `${dataQuality.usedMockData ? "Some competitor rows use labeled fallback demo data because live public data was sparse. " : ""}` +
      `This report is directional and evidence-backed, not verified internal company data.`,
    120
  );

  const methodologyNote = truncateWords(
    "Benchmark Scout geocodes the target market, discovers nearby businesses from OpenStreetMap, audits public homepages for SEO/conversion/trust/content/technical signals, scans for public momentum/risk/offer/hiring language, and checks GDELT for public news mentions. Category scores, adoption-rate comparisons, and score projections are computed deterministically from these observations, not estimated or generated by a language model.",
    75
  );

  const dataQualityNote = truncateWords(
    dataQuality.notes.length
      ? dataQuality.notes.join(" ")
      : `Discovery source: ${dataQuality.discoverySource}. ${dataQuality.usedMockData ? "Fallback demo rows were used to complete the competitor set." : "All competitor rows reflect live public data."} ${dataQuality.failedHomepageFetches} homepage fetch(es) failed and ${dataQuality.limitedAudits} audit(s) were limited.`,
    75
  );

  return {
    title: `Benchmark Scout Report — ${input.businessName} (${input.market})`,
    executiveSummary,
    positionStatement,
    topFindings: buildTopFindings(user, competitors, summary),
    topRisks: buildTopRisks(user, competitors),
    competitorHighlights: buildCompetitorHighlights(user, competitors),
    actionPlan: recommendations,
    methodologyNote,
    dataQualityNote,
  };
}
