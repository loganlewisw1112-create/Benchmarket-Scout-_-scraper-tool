import type { DataQuality } from "@/lib/types";

export default function DataQualityBanner({
  dataQuality,
}: {
  dataQuality: DataQuality;
}) {
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
      <p className="font-medium">
        This report uses real public data from OpenStreetMap, public websites,
        and public news sources. Unavailable evidence stays unavailable rather
        than being replaced with estimated or demo values. Signals are
        directional, not verified internal company facts.
      </p>
      {dataQuality.notes.length > 0 && (
        <ul className="mt-2 list-inside list-disc space-y-0.5 text-xs text-amber-800">
          {dataQuality.notes.map((note, idx) => (
            <li key={idx}>{note}</li>
          ))}
        </ul>
      )}
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-amber-800">
        <span>Real competitors found: {dataQuality.realCompetitorsFound}</span>
        <span>Scored competitors: {dataQuality.scoredCompetitors}</span>
        <span>Failed audits: {dataQuality.failedAudits}</span>
        <span>Limited audits: {dataQuality.limitedAudits}</span>
        <span className="font-semibold capitalize">
          Coverage status: {dataQuality.coverageStatus}
        </span>
      </div>
    </div>
  );
}
