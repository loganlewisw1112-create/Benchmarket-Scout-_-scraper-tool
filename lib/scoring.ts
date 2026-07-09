import type { CompetitorReport, MarketSummary, SignalScan } from "./types";

export type CategoryKey =
  | "seo"
  | "conversion"
  | "trust"
  | "content"
  | "technical";

export const CATEGORY_MAX_SCORES: Record<CategoryKey, number> = {
  seo: 25,
  conversion: 25,
  trust: 20,
  content: 20,
  technical: 10,
};

export const CATEGORY_LABELS: Record<CategoryKey, string> = {
  seo: "on-page SEO",
  conversion: "conversion elements",
  trust: "trust signals",
  content: "service/location content",
  technical: "technical fundamentals",
};

export type CategoryComparison = {
  category: CategoryKey;
  userScore: number;
  maxScore: number;
  competitorAverage: number;
  gap: number;
  competitorsAhead: number;
  totalCompetitors: number;
};

export function computeCategoryComparisons(
  user: CompetitorReport,
  competitors: CompetitorReport[]
): CategoryComparison[] {
  const categories = Object.keys(CATEGORY_MAX_SCORES) as CategoryKey[];
  const total = competitors.length || 1;

  return categories.map((category) => {
    const userScore = user.websiteAudit.scoreBreakdown[category];
    const avg =
      competitors.reduce(
        (sum, c) => sum + c.websiteAudit.scoreBreakdown[category],
        0
      ) / total;
    const competitorsAhead = competitors.filter(
      (c) => c.websiteAudit.scoreBreakdown[category] > userScore
    ).length;

    return {
      category,
      userScore,
      maxScore: CATEGORY_MAX_SCORES[category],
      competitorAverage: Math.round(avg * 10) / 10,
      gap: Math.round((avg - userScore) * 10) / 10,
      competitorsAhead,
      totalCompetitors: competitors.length,
    };
  });
}

export type AdoptionStat = {
  key: string;
  label: string;
  competitorAdoptionCount: number;
  totalCompetitors: number;
  userHasIt: boolean;
};

export function computeAdoptionStats(
  user: CompetitorReport,
  competitors: CompetitorReport[]
): AdoptionStat[] {
  const checks: Array<{
    key: string;
    label: string;
    getter: (c: CompetitorReport) => boolean;
  }> = [
    {
      key: "testimonials",
      label: "visible testimonials or client reviews",
      getter: (c) => c.websiteAudit.hasTestimonials,
    },
    {
      key: "booking",
      label: "a visible booking or quote request path",
      getter: (c) => c.websiteAudit.hasBookingOrQuote,
    },
    {
      key: "social",
      label: "a linked social profile",
      getter: (c) => c.websiteAudit.hasSocialLinks,
    },
    {
      key: "services",
      label: "a dedicated services page",
      getter: (c) => c.websiteAudit.hasServicesPage,
    },
    {
      key: "momentum",
      label: "public momentum, hiring, or offer language",
      getter: (c) =>
        c.signals.momentumSignals.length > 0 ||
        c.signals.offerSignals.length > 0 ||
        c.signals.hiringSignals.length > 0,
    },
  ];

  return checks.map((check) => ({
    key: check.key,
    label: check.label,
    competitorAdoptionCount: competitors.filter(check.getter).length,
    totalCompetitors: competitors.length,
    userHasIt: check.getter(user),
  }));
}

const CATEGORY_ADOPTION_KEY: Partial<Record<CategoryKey, string>> = {
  conversion: "booking",
  trust: "testimonials",
  content: "services",
};

export function adoptionStatForCategory(
  category: CategoryKey,
  adoptionStats: AdoptionStat[]
): AdoptionStat | undefined {
  const key = CATEGORY_ADOPTION_KEY[category];
  if (!key) return undefined;
  return adoptionStats.find((s) => s.key === key);
}

export type CategoryUplift = {
  category: CategoryKey;
  currentRank: number;
  projectedRank: number;
  projectedFinalScore: number;
  scoreDelta: number;
};

export function simulateCategoryUplift(
  user: CompetitorReport,
  competitors: CompetitorReport[],
  category: CategoryKey
): CategoryUplift | null {
  const comparisons = computeCategoryComparisons(user, competitors);
  const target = comparisons.find((c) => c.category === category);
  if (!target || target.gap <= 0.5) return null;

  const newCategoryScore = Math.min(
    target.maxScore,
    target.userScore + target.gap
  );
  const scoreDelta = Math.round(newCategoryScore - target.userScore);
  const newWebsiteScore = Math.min(
    100,
    user.websiteAudit.websiteScore + scoreDelta
  );

  const projectedFinalScore = computeFinalScore({
    websiteScore: newWebsiteScore,
    localPresenceScore: user.localPresenceScore,
    momentumScore: user.signals.momentumScore,
    riskScore: user.signals.riskScore,
  });

  const currentRank =
    user.rank ??
    competitors.filter((c) => c.finalScore > user.finalScore).length + 1;
  const projectedRank =
    competitors.filter((c) => c.finalScore > projectedFinalScore).length + 1;

  return {
    category,
    currentRank,
    projectedRank,
    projectedFinalScore,
    scoreDelta,
  };
}

export function computeMomentumScore(signals: SignalScan): number {
  const socialLinkCount = Object.keys(signals.socialLinks).length;
  return Math.min(
    100,
    signals.momentumSignals.length * 15 +
      signals.offerSignals.length * 8 +
      signals.hiringSignals.length * 10 +
      signals.newsSignals.length * 10 +
      socialLinkCount * 4
  );
}

export function computeRiskScore(signals: SignalScan): number {
  return Math.min(100, signals.riskSignals.length * 20);
}

export function computeChangeScore(signals: SignalScan): number {
  return Math.min(100, signals.changeSignals.length * 25);
}

export function computeFinalScore(args: {
  websiteScore: number;
  localPresenceScore: number;
  momentumScore: number;
  riskScore: number;
}): number {
  const { websiteScore, localPresenceScore, momentumScore, riskScore } = args;
  return Math.round(
    0.6 * websiteScore +
      0.2 * localPresenceScore +
      0.15 * momentumScore +
      0.05 * (100 - riskScore)
  );
}

export function computeLocalPresenceScore(args: {
  hasWebsite: boolean;
  hasPhoneOrEmail: boolean;
  hasAddressOrCoords: boolean;
  categoryMatch: boolean;
  osmCompleteness: number; // 0-1
}): number {
  let score = 0;
  if (args.hasWebsite) score += 30;
  if (args.hasPhoneOrEmail) score += 20;
  if (args.hasAddressOrCoords) score += 20;
  if (args.categoryMatch) score += 20;
  score += Math.round(args.osmCompleteness * 10);
  return Math.min(100, score);
}

export function statusForScore(
  score: number
): MarketSummary["status"] {
  if (score >= 80) return "leading";
  if (score >= 65) return "competitive";
  if (score >= 45) return "behind but recoverable";
  return "low visibility";
}

export function rankCompetitors(
  user: CompetitorReport,
  competitors: CompetitorReport[]
): { user: CompetitorReport; competitors: CompetitorReport[] } {
  const all = [user, ...competitors].sort(
    (a, b) => b.finalScore - a.finalScore
  );
  all.forEach((c, idx) => {
    c.rank = idx + 1;
  });

  return {
    user: all.find((c) => c.source === "user")!,
    competitors: all.filter((c) => c.source !== "user"),
  };
}

export function buildMarketSummary(
  user: CompetitorReport,
  competitors: CompetitorReport[]
): MarketSummary {
  const competitorCount = competitors.length;
  const avgWebsite =
    competitorCount > 0
      ? competitors.reduce((sum, c) => sum + c.websiteAudit.websiteScore, 0) /
        competitorCount
      : 0;
  const avgFinal =
    competitorCount > 0
      ? competitors.reduce((sum, c) => sum + c.finalScore, 0) /
        competitorCount
      : 0;

  const strongest = [...competitors].sort(
    (a, b) => b.finalScore - a.finalScore
  )[0];

  const marketGap = Math.round(user.finalScore - avgFinal);

  let biggestOpportunity: string | undefined;
  if (user.websiteAudit.scoreBreakdown) {
    const breakdown = user.websiteAudit.scoreBreakdown;
    const weakestArea = (
      Object.entries(breakdown) as [string, number][]
    ).sort((a, b) => a[1] - b[1])[0];
    if (weakestArea) {
      biggestOpportunity = weakestArea[0];
    }
  }

  return {
    competitorCount,
    competitorAverageWebsiteScore: Math.round(avgWebsite),
    competitorAverageFinalScore: Math.round(avgFinal),
    yourRank: user.rank ?? 1,
    marketGap,
    status: statusForScore(user.finalScore),
    strongestCompetitor: strongest?.name,
    biggestOpportunity,
  };
}
