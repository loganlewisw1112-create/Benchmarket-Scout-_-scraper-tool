import { classifyAuditOutcome, formatRank } from "@/lib/scoring";
import type { CompetitorReport } from "@/lib/types";
import { OsmAttribution } from "./ProvenanceDetails";

function SourceBadge({ source }: { source: CompetitorReport["source"] }) {
  if (source === "user") {
    return (
      <span className="inline-block rounded-full border border-indigo-200 bg-indigo-50 px-2 py-0.5 text-[11px] font-medium text-indigo-700">
        Your business
      </span>
    );
  }
  return (
    <span className="inline-block rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-800">
      Public/OSM
    </span>
  );
}

function metric(value: number | null): string {
  return value === null ? "N/A" : String(value);
}

function distance(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "N/A";
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} km`;
}

/** Why a row has no final score, in plain words (never "failed" for no website). */
function statusNote(record: CompetitorReport): string | null {
  const outcome = classifyAuditOutcome(record);
  switch (outcome.kind) {
    case "scored":
      return record.auditStatus === "partial"
        ? "Website audit partial (some linked pages unavailable)"
        : null;
    case "no_website":
      return "Discovered; no website listed";
    case "not_attempted":
      return "Discovered; not audited (report audit limit)";
    case "excluded_chain":
      return `Not ranked: ${outcome.reason}${record.brand ? ` (${record.brand})` : ""}`;
    default: {
      const reason = outcome.reason ?? "website audit failed";
      return reason.charAt(0).toUpperCase() + reason.slice(1);
    }
  }
}

export default function CompetitorTable({
  user,
  competitors,
}: {
  user: CompetitorReport;
  competitors: CompetitorReport[];
}) {
  const rows = [user, ...competitors].sort((a, b) => {
    if (a.rank === null && b.rank === null) return 0;
    if (a.rank === null) return 1;
    if (b.rank === null) return -1;
    return a.rank - b.rank || (a === user ? -1 : b === user ? 1 : 0);
  });
  const showDistance = competitors.some((c) => c.distanceKm !== undefined);
  const headers = [
    "Rank",
    "Business",
    "Source",
    ...(showDistance ? ["Distance"] : []),
    "Website",
    "Local",
    "Momentum",
    "Risk",
    "Final",
  ];

  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50">
            <tr>
              {headers.map((h) => (
                <th
                  key={h}
                  className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-slate-600"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((c) => {
              const note = statusNote(c);
              return (
                <tr
                  key={c.id}
                  className={c.source === "user" ? "bg-indigo-50/50" : undefined}
                >
                  <td className="whitespace-nowrap px-4 py-2.5 font-medium text-slate-700">
                    {formatRank(c.rank, c.rankTied)}
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="font-medium text-slate-900">{c.name}</div>
                    {note && (
                      <div className="mt-0.5 text-[11px] font-medium text-amber-800">
                        {note}
                      </div>
                    )}
                    {c.website && (
                      <div className="max-w-[220px] truncate text-xs text-slate-600">
                        {c.website}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <SourceBadge source={c.source} />
                  </td>
                  {showDistance && (
                    <td className="whitespace-nowrap px-4 py-2.5 text-slate-700">
                      {c.source === "user" ? "N/A" : distance(c.distanceKm)}
                    </td>
                  )}
                  <td className="px-4 py-2.5 text-slate-700">
                    {metric(c.websiteAudit.websiteScore)}
                  </td>
                  <td className="px-4 py-2.5 text-slate-700">
                    {metric(c.localPresenceScore)}
                  </td>
                  <td className="px-4 py-2.5 text-slate-700">
                    {metric(c.signals.momentumScore)}
                  </td>
                  <td className="px-4 py-2.5 text-slate-700">
                    {metric(c.signals.riskScore)}
                  </td>
                  <td className="px-4 py-2.5 font-semibold text-slate-900">
                    {metric(c.finalScore)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="border-t border-slate-100 px-4 py-2.5 text-xs text-slate-600">
        <p>
          Equal final scores share a rank. Inputs that could not be observed
          for a business are N/A and left out of its maximum, not counted as
          zero.
        </p>
        <OsmAttribution className="mt-1" />
      </div>
    </div>
  );
}
