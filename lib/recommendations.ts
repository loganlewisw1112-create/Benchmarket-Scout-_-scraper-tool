import {
  CATEGORY_LABELS,
  adoptionStatForCategory,
  computeAdoptionStats,
  computeCategoryComparisons,
  type AdoptionStat,
  type CategoryComparison,
  type CategoryKey,
} from "./scoring";
import type { CompetitorReport, Recommendation } from "./types";

const CATEGORY_ACTIONS: Record<CategoryKey, string> = {
  seo: "Add a descriptive page title and meta description that include your service and city, and ensure a clear H1 with 300+ words of body content.",
  conversion:
    "Add a visible phone number/email and a prominent 'Get a Quote' or 'Book Now' button on your homepage.",
  trust:
    "Publish 2-3 client testimonials and list certifications, licenses, or insurance directly on your homepage.",
  content:
    "Create a services page listing offerings and mention your city/service area explicitly in the copy.",
  technical:
    "Confirm HTTPS is enabled, add a responsive viewport meta tag, and reduce homepage load time.",
};

function categoryRecommendation(
  comparison: CategoryComparison,
  adoption: AdoptionStat | undefined
): Omit<Recommendation, "priority"> {
  const label = CATEGORY_LABELS[comparison.category];
  const adoptionSentence =
    adoption && !adoption.userHasIt
      ? ` ${adoption.competitorAdoptionCount} of ${adoption.totalCompetitors} tracked competitors show ${adoption.label}; your homepage does not.`
      : "";

  return {
    title: `Close the ${label} gap`,
    why: `You score ${comparison.userScore}/${comparison.maxScore} on ${label}, versus a market average of ${comparison.competitorAverage}/${comparison.maxScore} — ${comparison.competitorsAhead} of ${comparison.totalCompetitors} tracked competitors score higher here.${adoptionSentence}`,
    action: CATEGORY_ACTIONS[comparison.category],
  };
}

function priorityForGap(gap: number): Recommendation["priority"] {
  if (gap > 8) return "high";
  if (gap > 4) return "medium";
  return "low";
}

type GenericTemplate = {
  key: string;
  title: string;
  baseWhy: string;
  action: string;
};

const GENERIC_POOL: GenericTemplate[] = [
  {
    key: "social",
    title: "Establish a visible social media presence",
    baseWhy:
      "A visible social profile link is a low-effort public trust signal many competitors already show.",
    action:
      "Add links to at least one active social profile (Facebook, Instagram, or LinkedIn) in your site header or footer.",
  },
  {
    key: "momentum",
    title: "Publicize business momentum",
    baseWhy:
      "Public signals like awards, new locations, or milestones help visitors perceive an active, growing business.",
    action:
      "Add a short 'News' or 'Updates' section highlighting recent milestones, awards, or service area expansion.",
  },
  {
    key: "local",
    title: "Improve local directory completeness",
    baseWhy:
      "A complete public profile (address, phone, hours) improves how easily customers and directories can find you.",
    action:
      "Ensure your business name, address, and phone number are consistent and complete across your website and public listings.",
  },
  {
    key: "gallery",
    title: "Add a simple case study or gallery",
    baseWhy:
      "Visual proof of past work is a common differentiator among stronger local competitors.",
    action:
      "Add 3-5 before/after photos or a short case study describing a recent completed job.",
  },
  {
    key: "risk",
    title: "Monitor and respond to visible risk signals",
    baseWhy:
      "Public signals such as reduced hours or service disruptions can affect customer confidence if left unaddressed.",
    action:
      "Review your homepage for outdated notices and update or remove any language suggesting reduced availability.",
  },
];

function genericRecommendation(
  template: GenericTemplate,
  adoptionStats: AdoptionStat[]
): Omit<Recommendation, "priority"> {
  const adoptionKey = template.key === "social" ? "social" : template.key === "momentum" ? "momentum" : undefined;
  const adoption = adoptionKey
    ? adoptionStats.find((s) => s.key === adoptionKey)
    : undefined;

  const why =
    adoption && !adoption.userHasIt
      ? `${adoption.competitorAdoptionCount} of ${adoption.totalCompetitors} tracked competitors show ${adoption.label}; your public pages do not. ${template.baseWhy}`
      : template.baseWhy;

  return { title: template.title, why, action: template.action };
}

export function generateRecommendations(args: {
  user: CompetitorReport;
  competitors: CompetitorReport[];
}): Recommendation[] {
  const { user, competitors } = args;

  const recommendations: Recommendation[] = [];

  if (competitors.length > 0) {
    const comparisons = computeCategoryComparisons(user, competitors);
    const adoptionStats = computeAdoptionStats(user, competitors);

    const gaps = comparisons
      .filter((c) => c.gap > 0.5)
      .sort((a, b) => b.gap - a.gap);

    for (const gap of gaps) {
      if (recommendations.length >= 5) break;
      const adoption = adoptionStatForCategory(gap.category, adoptionStats);
      const rec = categoryRecommendation(gap, adoption);
      recommendations.push({ ...rec, priority: priorityForGap(gap.gap) });
    }

    let genericIdx = 0;
    while (recommendations.length < 5 && genericIdx < GENERIC_POOL.length) {
      const template = GENERIC_POOL[genericIdx];
      if (!recommendations.some((r) => r.title === template.title)) {
        recommendations.push({
          ...genericRecommendation(template, adoptionStats),
          priority: "medium",
        });
      }
      genericIdx++;
    }
  } else {
    for (const template of GENERIC_POOL) {
      recommendations.push({
        title: template.title,
        why: template.baseWhy,
        action: template.action,
        priority: "medium",
      });
    }
  }

  return recommendations.slice(0, 5);
}
