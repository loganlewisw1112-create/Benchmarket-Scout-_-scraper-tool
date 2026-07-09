import type { DataQuality } from "@/lib/types";

export default function DataQualityBanner({
  dataQuality,
}: {
  dataQuality: DataQuality;
}) {
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
      <p className="font-medium">
        This report uses public web data, OpenStreetMap, public websites, and
        public news signals. Some rows may use labeled fallback demo data when
        free public data is sparse or unavailable. Signals are directional,
        not verified internal company facts.
      </p>
      {dataQuality.notes.length > 0 && (
        <ul className="mt-2 list-inside list-disc space-y-0.5 text-xs text-amber-800">
          {dataQuality.notes.map((note, idx) => (
            <li key={idx}>{note}</li>
          ))}
        </ul>
      )}
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-amber-800">
        <span>Discovery source: {dataQuality.discoverySource}</span>
        <span>Live competitors found: {dataQuality.liveCompetitorsFound}</span>
        <span>Failed homepage fetches: {dataQuality.failedHomepageFetches}</span>
        <span>Limited audits: {dataQuality.limitedAudits}</span>
        {dataQuality.usedMockData && (
          <span className="font-semibold">Fallback demo rows in use</span>
        )}
      </div>
    </div>
  );
}
