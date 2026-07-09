import type { CompetitorReport } from "@/lib/types";

function SourceBadge({ source }: { source: CompetitorReport["source"] }) {
  if (source === "mock") {
    return (
      <span className="inline-block rounded-full border border-purple-200 bg-purple-50 px-2 py-0.5 text-[11px] font-medium text-purple-700">
        Fallback demo row
      </span>
    );
  }
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

export default function CompetitorTable({
  user,
  competitors,
}: {
  user: CompetitorReport;
  competitors: CompetitorReport[];
}) {
  const rows = [user, ...competitors].sort(
    (a, b) => (a.rank ?? 99) - (b.rank ?? 99)
  );

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
                #{c.rank}
              </td>
              <td className="px-4 py-2.5">
                <div className="font-medium text-slate-900">{c.name}</div>
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
                {c.websiteAudit.websiteScore}
              </td>
              <td className="px-4 py-2.5 text-slate-700">
                {c.localPresenceScore}
              </td>
              <td className="px-4 py-2.5 text-slate-700">
                {c.signals.momentumScore}
              </td>
              <td className="px-4 py-2.5 text-slate-700">
                {c.signals.riskScore}
              </td>
              <td className="px-4 py-2.5 font-semibold text-slate-900">
                {c.finalScore}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
