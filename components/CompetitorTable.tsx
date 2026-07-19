import type { CompetitorReport } from "@/lib/types";

function SourceBadge({ source }: { source: CompetitorReport["source"] }) {
  if (source === "user") {
    return (
      <span className="inline-block rounded-full border border-indigo-200 bg-indigo-50 px-2 py-0.5 text-[11px] font-medium text-indigo-700">
        Your business
      </span>
    );
  }
  return (
    <span className="inline-block rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
      Public/OSM
    </span>
  );
}

function metric(value: number | null): string {
  return value === null ? "N/A" : String(value);
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
    return a.rank - b.rank;
  });

  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
      <table className="min-w-full divide-y divide-slate-200 text-sm">
        <thead className="bg-slate-50">
          <tr>
            {[
              "Rank",
              "Business",
              "Source",
              "Website",
              "Local",
              "Momentum",
              "Risk",
              "Final",
            ].map((h) => (
              <th
                key={h}
                className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-slate-500"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((c) => (
            <tr
              key={c.id}
              className={c.source === "user" ? "bg-indigo-50/50" : undefined}
            >
              <td className="px-4 py-2.5 font-medium text-slate-700">
                {c.rank === null ? "N/A" : `#${c.rank}`}
              </td>
              <td className="px-4 py-2.5">
                <div className="font-medium text-slate-900">{c.name}</div>
                {c.auditStatus !== "complete" && (
                  <div className="mt-0.5 text-[11px] font-medium text-amber-700">
                    {c.auditStatus === "unavailable"
                      ? "Discovered; website audit unavailable"
                      : "Website audit partial"}
                  </div>
                )}
                {c.website && (
                  <div className="truncate text-xs text-slate-400 max-w-[220px]">
                    {c.website}
                  </div>
                )}
              </td>
              <td className="px-4 py-2.5">
                <SourceBadge source={c.source} />
              </td>
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
          ))}
        </tbody>
      </table>
    </div>
  );
}
