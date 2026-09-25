import {
  AUDIT_ELEMENTS,
  CATEGORY_KEYS,
  CATEGORY_LABELS,
  CATEGORY_MAX_SCORES,
  auditObservationSourceIds,
  displayStatusForSummary,
  formatRank,
  isScored,
} from "@/lib/scoring";
import type { CompetitorReport, MarketSummary } from "@/lib/types";
import { CitationMarkers } from "./ProvenanceDetails";

function statusColor(status: MarketSummary["status"]) {
  switch (status) {
    case "leading":
      return "bg-emerald-100 text-emerald-800 border-emerald-200";
    case "competitive":
      return "bg-blue-100 text-blue-800 border-blue-200";
    case "behind but recoverable":
      return "bg-amber-100 text-amber-800 border-amber-200";
    case "low visibility":
      return "bg-red-100 text-red-800 border-red-200";
    default:
      return "bg-slate-100 text-slate-700 border-slate-200";
  }
}

function metric(value: number | null, suffix = ""): string {
  return value === null ? "N/A" : `${value}${suffix}`;
}

function signedMetric(value: number | null): string {
  if (value === null) return "N/A";
  return `${value > 0 ? "+" : ""}${value || 0}`;
}

/** The status shown next to rank and gap (see displayStatusForSummary). */
export const displayStatus = displayStatusForSummary;

export function rankText(summary: MarketSummary, user: CompetitorReport): string {
  if (summary.yourRank === null) return "N/A";
  return `${formatRank(summary.yourRank, user.rankTied)} of ${summary.auditedCompetitorCount + 1}`;
}

function Card({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-600">
        {label}
      </p>
      <p className="mt-1 text-2xl font-semibold text-slate-900">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-slate-600">{sub}</p>}
    </div>
  );
}

function CategoryBreakdown({
  user,
  competitors,
}: {
  user: CompetitorReport;
  competitors: CompetitorReport[];
}) {
  const scored = competitors.filter(isScored);
  const userSources = auditObservationSourceIds(user);
  const userAudited = user.auditStatus !== "unavailable";

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <h3 className="text-sm font-semibold text-slate-900">
        Website score by category
      </h3>
      <p className="mt-1 text-xs text-slate-600">
        Your homepage audit per category, the scored-competitor average, and
        the elements the audit checked.
        <CitationMarkers sourceIds={userAudited ? userSources : []} />
      </p>
      <div className="mt-4 overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
          <thead className="bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-600">
            <tr>
              <th className="px-3 py-2">Category</th>
              <th className="px-3 py-2">You</th>
              <th className="px-3 py-2">Competitor avg.</th>
              <th className="px-3 py-2">What the audit found</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 align-top text-slate-700">
            {CATEGORY_KEYS.map((category) => {
              const max = CATEGORY_MAX_SCORES[category];
              const userScore = user.websiteAudit.scoreBreakdown[category];
              const competitorScores = scored
                .map((c) => c.websiteAudit.scoreBreakdown[category])
                .filter((value): value is number => value !== null);
              const average = competitorScores.length
                ? Math.round(
                    (competitorScores.reduce((sum, value) => sum + value, 0) /
                      competitorScores.length) *
                      10
                  ) / 10
                : null;
              const elements = AUDIT_ELEMENTS.filter(
                (element) => element.category === category
              );
              return (
                <tr key={category}>
                  <th scope="row" className="px-3 py-2 font-medium text-slate-900">
                    {CATEGORY_LABELS[category]}
                  </th>
                  <td className="whitespace-nowrap px-3 py-2">
                    {userScore === null ? "N/A" : `${userScore}/${max}`}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">
                    {average === null ? "N/A" : `${average}/${max}`}
                  </td>
                  <td className="px-3 py-2">
                    {userAudited ? (
                      <ul className="space-y-0.5 text-xs">
                        {elements.map((element) => {
                          const found = element.observe(user.websiteAudit);
                          return (
                            <li key={element.key}>
                              <span
                                aria-hidden="true"
                                className={
                                  found === true
                                    ? "text-emerald-700"
                                    : found === false
                                      ? "text-red-700"
                                      : "text-slate-600"
                                }
                              >
                                {found === true ? "✓" : found === false ? "✗" : "–"}
                              </span>{" "}
                              <span className="sr-only">
                                {found === true
                                  ? "Found:"
                                  : found === false
                                    ? "Not found:"
                                    : "Not observed:"}
                              </span>
                              {element.label}
                              <span className="text-slate-600">
                                {" "}
                                ({element.points} pts)
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    ) : (
                      <span className="text-xs text-slate-600">
                        N/A: your website audit was unavailable.
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function ScoreCards({
  user,
  summary,
  competitors,
}: {
  user: CompetitorReport;
  summary: MarketSummary;
  competitors?: CompetitorReport[];
}) {
  const status = displayStatus(summary);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Card
          label="Your final score"
          value={metric(user.finalScore, "/100")}
          sub={`Website ${metric(user.websiteAudit.websiteScore)} · Local ${metric(user.localPresenceScore)}`}
        />
        <Card
          label="Market rank"
          value={rankText(summary, user)}
          sub={
            summary.yourRank === null && user.finalScore !== null
              ? "No scored competitor to rank against"
              : undefined
          }
        />
        <Card
          label="Market gap"
          value={signedMetric(summary.marketGap)}
          sub={`Competitor average ${metric(summary.competitorAverageFinalScore, "/100")}`}
        />
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-600">
            Status
          </p>
          <span
            className={`mt-2 inline-block rounded-full border px-3 py-1 text-xs font-semibold capitalize ${statusColor(
              status
            )}`}
          >
            {status ?? "N/A"}
          </span>
          <p className="mt-1 text-xs text-slate-600">From rank and market gap</p>
        </div>
      </div>
      {competitors ? (
        <CategoryBreakdown user={user} competitors={competitors} />
      ) : null}
    </div>
  );
}
