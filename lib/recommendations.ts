import { dedupeSourceIds } from "./provenance";
import {
  CATEGORY_LABELS,
  adoptionStatForCategory,
  computeAdoptionStats,
  computeCategoryComparisons,
  type CategoryKey,
} from "./scoring";
import type { CompetitorReport, Recommendation } from "./types";

const CATEGORY_ACTIONS: Record<CategoryKey, string> = {
  seo: "Add a descriptive page title, meta description, clear H1, and substantive service-and-location copy where the audit found those elements missing.",
  conversion:
    "Add an observed-missing contact path and a prominent quote or booking action to the homepage.",
  trust:
    "Add verifiable testimonials, credentials, licenses, insurance, or project evidence to the homepage.",
  content:
    "Add a dedicated services page and explicit service-area content where the audit found that coverage missing.",
  technical:
    "Address the observed HTTPS, viewport, response-size, or homepage-speed gaps from this audit.",
};

function priorityForGap(gap: number): Recommendation["priority"] {
  if (gap > 8) return "high";
  if (gap > 4) return "medium";
  return "low";
}

export function generateRecommendations(args: {
  user: CompetitorReport;
  competitors: CompetitorReport[];
}): Recommendation[] {
  const comparisons = computeCategoryComparisons(args.user, args.competitors);
  if (comparisons.length === 0) return [];
  const adoptionStats = computeAdoptionStats(args.user, args.competitors);
  const sourceIds = dedupeSourceIds([
    ...args.user.sourceIds,
    ...args.competitors.flatMap((competitor) => competitor.sourceIds),
  ]);

  return comparisons
    .filter((comparison) => comparison.gap > 0.5)
    .sort((left, right) => right.gap - left.gap)
    .slice(0, 5)
    .map((comparison) => {
      const label = CATEGORY_LABELS[comparison.category];
      const adoption = adoptionStatForCategory(
        comparison.category,
        adoptionStats
      );
      const adoptionEvidence =
        adoption &&
        adoption.userHasIt === false &&
        adoption.totalCompetitors > 0
          ? ` ${adoption.competitorAdoptionCount} of ${adoption.totalCompetitors} successfully audited competitors show ${adoption.label}; the user audit did not.`
          : "";
      const evidence = `Observed ${label}: user ${comparison.userScore}/${comparison.maxScore}; competitor average ${comparison.competitorAverage}/${comparison.maxScore} across ${comparison.totalCompetitors} successful audits.${adoptionEvidence}`;
      return {
        title: `Close the ${label} gap`,
        why: evidence,
        action: CATEGORY_ACTIONS[comparison.category],
        evidence,
        sourceIds,
        priority: priorityForGap(comparison.gap),
      };
    });
}
