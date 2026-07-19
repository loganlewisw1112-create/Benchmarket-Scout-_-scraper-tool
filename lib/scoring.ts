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

function categoryScore(
  report: CompetitorReport,
  category: CategoryKey
): number | null {
  return report.websiteAudit.scoreBreakdown[category];
}

export function computeCategoryComparisons(
  user: CompetitorReport,
  competitors: CompetitorReport[]
): CategoryComparison[] {
  return (Object.keys(CATEGORY_MAX_SCORES) as CategoryKey[]).flatMap(
    (category) => {
      const userScore = categoryScore(user, category);
      const scores = competitors
        .map((competitor) => categoryScore(competitor, category))
        .filter((score): score is number => score !== null);
      if (userScore === null || scores.length === 0) return [];
      const average = scores.reduce((sum, score) => sum + score, 0) / scores.length;
      return [
        {
          category,
          userScore,
          maxScore: CATEGORY_MAX_SCORES[category],
          competitorAverage: Math.round(average * 10) / 10,
          gap: Math.round((average - userScore) * 10) / 10,
          competitorsAhead: scores.filter((score) => score > userScore).length,
          totalCompetitors: scores.length,
        },
      ];
    }
  );
}

export type AdoptionStat = {
  key: string;
  label: string;
  competitorAdoptionCount: number;
  totalCompetitors: number;
  userHasIt: boolean | null;
};

export function computeAdoptionStats(
  user: CompetitorReport,
  competitors: CompetitorReport[]
): AdoptionStat[] {
  const checks: Array<{
    key: string;
    label: string;
    getter: (report: CompetitorReport) => boolean | null;
  }> = [
    {
      key: "testimonials",
      label: "visible testimonials or client reviews",
      getter: (report) => report.websiteAudit.hasTestimonials,
    },
    {
      key: "booking",
      label: "a visible booking or quote request path",
      getter: (report) => report.websiteAudit.hasBookingOrQuote,
    },
    {
      key: "social",
      label: "a linked social profile",
      getter: (report) => report.websiteAudit.hasSocialLinks,
    },
    {
      key: "services",
      label: "a dedicated services page",
      getter: (report) => report.websiteAudit.hasServicesPage,
    },
    {
      key: "momentum",
      label: "public momentum, hiring, or offer language",
      getter: (report) =>
        report.signals.auditStatus === "unavailable"
          ? null
          : report.signals.momentumSignals.length > 0 ||
            report.signals.offerSignals.length > 0 ||
            report.signals.hiringSignals.length > 0,
    },
  ];

  return checks.map((check) => {
    const observed = competitors
      .map(check.getter)
      .filter((value): value is boolean => value !== null);
    return {
      key: check.key,
      label: check.label,
      competitorAdoptionCount: observed.filter(Boolean).length,
      totalCompetitors: observed.length,
      userHasIt: check.getter(user),
    };
  });
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
  return key ? adoptionStats.find((stat) => stat.key === key) : undefined;
}

export function computeMomentumScore(signals: SignalScan): number | null {
  if (signals.auditStatus === "unavailable") return null;
  return Math.min(
    100,
    signals.momentumSignals.length * 15 +
      signals.offerSignals.length * 8 +
      signals.hiringSignals.length * 10 +
      signals.newsSignals.length * 10 +
      Object.keys(signals.socialLinks).length * 4
  );
}

export function computeRiskScore(signals: SignalScan): number | null {
  return signals.auditStatus === "unavailable"
    ? null
    : Math.min(100, signals.riskSignals.length * 20);
}

export function computeChangeScore(signals: SignalScan): number | null {
  return signals.auditStatus === "unavailable"
    ? null
    : Math.min(100, signals.changeSignals.length * 25);
}

export function computeFinalScore(args: {
  websiteScore: number | null;
  localPresenceScore: number | null;
  momentumScore: number | null;
  riskScore: number | null;
}): number | null {
  const values = [
    args.websiteScore,
    args.localPresenceScore,
    args.momentumScore,
    args.riskScore,
  ];
  if (values.some((value) => value === null)) return null;
  return Math.round(
    0.6 * args.websiteScore! +
      0.2 * args.localPresenceScore! +
      0.15 * args.momentumScore! +
      0.05 * (100 - args.riskScore!)
  );
}

export function computeLocalPresenceScore(args: {
  hasWebsite: boolean;
  hasPhoneOrEmail: boolean;
  hasAddressOrCoords: boolean;
  categoryMatch: boolean;
  osmCompleteness: number;
}): number {
  let score = 0;
  if (args.hasWebsite) score += 30;
  if (args.hasPhoneOrEmail) score += 20;
  if (args.hasAddressOrCoords) score += 20;
  if (args.categoryMatch) score += 20;
  score += Math.round(Math.max(0, Math.min(1, args.osmCompleteness)) * 10);
  return Math.min(100, score);
}

export function statusForScore(score: number): NonNullable<MarketSummary["status"]> {
  if (score >= 80) return "leading";
  if (score >= 65) return "competitive";
  if (score >= 45) return "behind but recoverable";
  return "low visibility";
}

export function isScored(report: CompetitorReport): boolean {
  return report.auditStatus !== "unavailable" && report.finalScore !== null;
}

export function rankCompetitors(
  user: CompetitorReport,
  competitors: CompetitorReport[]
): { user: CompetitorReport; competitors: CompetitorReport[] } {
  const all = [user, ...competitors];
  all.forEach((report) => {
    report.rank = null;
  });
  const scored = all
    .filter(isScored)
    .sort(
      (left, right) =>
        right.finalScore! - left.finalScore! || left.id.localeCompare(right.id)
    );
  scored.forEach((report, index) => {
    report.rank = index + 1;
  });

  return {
    user,
    competitors: [
      ...competitors.filter(isScored).sort((a, b) => a.rank! - b.rank!),
      ...competitors.filter((competitor) => !isScored(competitor)),
    ],
  };
}

export function buildMarketSummary(
  user: CompetitorReport,
  competitors: CompetitorReport[]
): MarketSummary {
  const scored = competitors.filter(isScored);
  const averageWebsite = scored.length
    ? scored.reduce((sum, report) => sum + report.websiteAudit.websiteScore!, 0) /
      scored.length
    : null;
  const averageFinal = scored.length
    ? scored.reduce((sum, report) => sum + report.finalScore!, 0) / scored.length
    : null;
  const strongest = scored[0];
  const marketGap =
    user.finalScore !== null && averageFinal !== null
      ? Math.round(user.finalScore - averageFinal)
      : null;
  const availableBreakdown = Object.entries(user.websiteAudit.scoreBreakdown)
    .filter((entry): entry is [string, number] => entry[1] !== null)
    .sort((left, right) => left[1] - right[1]);

  return {
    competitorCount: competitors.length,
    auditedCompetitorCount: scored.length,
    competitorAverageWebsiteScore:
      averageWebsite === null ? null : Math.round(averageWebsite),
    competitorAverageFinalScore:
      averageFinal === null ? null : Math.round(averageFinal),
    yourRank: user.rank,
    marketGap,
    status: user.finalScore === null ? null : statusForScore(user.finalScore),
    strongestCompetitor: strongest?.name,
    biggestOpportunity: availableBreakdown[0]?.[0],
  };
}
