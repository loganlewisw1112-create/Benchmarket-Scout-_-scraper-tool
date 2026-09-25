import type { Recommendation } from "@/lib/types";
import { CitationMarkers } from "./ProvenanceDetails";

function PriorityBadge({ priority }: { priority: Recommendation["priority"] }) {
  const styles = {
    high: "bg-red-100 text-red-800 border-red-200",
    medium: "bg-amber-100 text-amber-800 border-amber-200",
    low: "bg-slate-100 text-slate-700 border-slate-200",
  } as const;
  return (
    <span
      className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-semibold capitalize ${styles[priority]}`}
    >
      {priority} priority
    </span>
  );
}

export const DEFAULT_EMPTY_ACTION_PLAN =
  "No material gaps found: no recommendation is supported by this report's evidence.";

export default function RecommendationPanel({
  recommendations,
  emptyStatement,
}: {
  recommendations: Recommendation[];
  /** Shown instead of an empty list (report.actionPlanNote when present). */
  emptyStatement?: string;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <h3 className="text-sm font-semibold text-slate-900">
        Recommended Next Actions
      </h3>
      {recommendations.length === 0 ? (
        <p className="mt-4 text-sm text-slate-700">
          {emptyStatement ?? DEFAULT_EMPTY_ACTION_PLAN}
        </p>
      ) : (
        <ol className="mt-4 space-y-3">
          {recommendations.map((rec, idx) => (
            <li
              key={idx}
              className="rounded-lg border border-slate-100 bg-slate-50 p-3"
            >
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm font-semibold text-slate-900">
                  {idx + 1}. {rec.title}
                </p>
                <PriorityBadge priority={rec.priority} />
              </div>
              <p className="mt-1 text-xs text-slate-700">
                {rec.why}
                <CitationMarkers sourceIds={rec.sourceIds} />
              </p>
              <p className="mt-1.5 text-xs font-medium text-indigo-800">
                Action: {rec.action}
              </p>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
