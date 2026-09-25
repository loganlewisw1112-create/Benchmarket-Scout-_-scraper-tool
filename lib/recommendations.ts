import { dedupeSourceIds } from "./provenance";
import {
  AUDIT_ELEMENTS,
  CATEGORY_LABELS,
  CATEGORY_MAX_SCORES,
  auditObservationSourceIds,
  isScored,
  type AuditElement,
} from "./scoring";
import type { CompetitorReport, Recommendation } from "./types";

const MAX_RECOMMENDATIONS = 5;

type ElementGap = {
  element: AuditElement;
  adopters: CompetitorReport[];
  observedCompetitors: number;
};

function adoptionShare(gap: ElementGap): number {
  return gap.observedCompetitors === 0
    ? 0
    : gap.adopters.length / gap.observedCompetitors;
}

function priorityFor(gap: ElementGap): Recommendation["priority"] {
  const share = adoptionShare(gap);
  if (share >= 0.5 && gap.element.points >= 5) return "high";
  if (share > 0) return "medium";
  return "low";
}

function listNames(reports: CompetitorReport[], max = 3): string {
  const names = reports.slice(0, max).map((report) => report.name);
  const extra = reports.length - names.length;
  if (extra > 0) return `${names.join(", ")} and ${extra} more`;
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * One recommendation per homepage element the user's own audit observed as
 * missing (never for elements it has, or that were not observed). Each cites
 * only the user's homepage observation plus the homepages of scored
 * competitors that do show the element. Competitor adoption is mentioned only
 * when at least one scored competitor has it; "0 of N" is never presented as
 * support. Returns [] when the user is unscored or no competitor was scored.
 */
export function generateRecommendations(args: {
  user: CompetitorReport;
  competitors: CompetitorReport[];
}): Recommendation[] {
  if (!isScored(args.user)) return [];
  const scoredCompetitors = args.competitors.filter(isScored);
  if (scoredCompetitors.length === 0) return [];
  const userSourceIds = auditObservationSourceIds(args.user);
  if (userSourceIds.length === 0) return [];

  const gaps: ElementGap[] = AUDIT_ELEMENTS.flatMap((element) => {
    if (element.observe(args.user.websiteAudit) !== false) return [];
    const observed = scoredCompetitors
      .map((competitor) => ({
        competitor,
        has: element.observe(competitor.websiteAudit),
      }))
      .filter((item) => item.has !== null);
    return [
      {
        element,
        adopters: observed
          .filter((item) => item.has === true)
          .map((item) => item.competitor),
        observedCompetitors: observed.length,
      },
    ];
  });
  const missingKeys = new Set(gaps.map((gap) => gap.element.key));

  return gaps
    .filter(
      (gap) => !gap.element.coveredBy || !missingKeys.has(gap.element.coveredBy)
    )
    .sort(
      (left, right) =>
        adoptionShare(right) - adoptionShare(left) ||
        right.element.points - left.element.points
    )
    .slice(0, MAX_RECOMMENDATIONS)
    .map((gap) => {
      const { element } = gap;
      const categoryLabel = CATEGORY_LABELS[element.category];
      const adoption =
        gap.adopters.length > 0
          ? ` ${gap.adopters.length} of ${gap.observedCompetitors} scored competitors show it (${listNames(gap.adopters)}).`
          : "";
      const why = `Your homepage audit did not find ${element.label}.${adoption}`;
      return {
        title: element.title,
        why,
        action: element.action,
        evidence: `${why} It is worth ${element.points} of the ${CATEGORY_MAX_SCORES[element.category]} ${categoryLabel} points in this audit.`,
        sourceIds: dedupeSourceIds([
          ...userSourceIds,
          ...gap.adopters.flatMap(auditObservationSourceIds),
        ]),
        priority: priorityFor(gap),
      };
    });
}
