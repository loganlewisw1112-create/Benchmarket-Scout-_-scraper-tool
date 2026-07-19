import type { CompetitorReport, MarketSummary } from "@/lib/types";

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
      return "bg-slate-100 text-slate-600 border-slate-200";
  }
}

function metric(value: number | null, suffix = ""): string {
  return value === null ? "N/A" : `${value}${suffix}`;
}

function signedMetric(value: number | null): string {
  if (value === null) return "N/A";
  return `${value >= 0 ? "+" : ""}${value}`;
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
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </p>
      <p className="mt-1 text-2xl font-semibold text-slate-900">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-slate-500">{sub}</p>}
    </div>
  );
}

export default function ScoreCards({
  user,
  summary,
}: {
  user: CompetitorReport;
  summary: MarketSummary;
}) {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
      <Card
        label="Your final score"
        value={metric(user.finalScore, "/100")}
        sub={`Website ${metric(user.websiteAudit.websiteScore)} · Local ${metric(user.localPresenceScore)}`}
      />
      <Card
        label="Market rank"
        value={
          summary.yourRank === null
            ? "N/A"
            : `#${summary.yourRank} of ${summary.auditedCompetitorCount + 1}`
        }
      />
      <Card
        label="Market gap"
        value={signedMetric(summary.marketGap)}
        sub={`Competitor average ${metric(summary.competitorAverageFinalScore, "/100")}`}
      />
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
          Status
        </p>
        <span
          className={`mt-2 inline-block rounded-full border px-3 py-1 text-xs font-semibold capitalize ${statusColor(
            summary.status
          )}`}
        >
          {summary.status ?? "N/A"}
        </span>
      </div>
    </div>
  );
}
