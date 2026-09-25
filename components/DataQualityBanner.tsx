import { classifyAuditOutcome, countAuditOutcomes } from "@/lib/scoring";
import type { CompetitorReport, DataQuality } from "@/lib/types";

const DAY_MS = 24 * 60 * 60 * 1000;

/** "Sep 22, 2026" and "2 days ago" for a report timestamp; null if invalid. */
export function describeReportAge(
  generatedAt: string | undefined,
  now: number = Date.now()
): { date: string; age: string; days: number } | null {
  if (!generatedAt) return null;
  const time = Date.parse(generatedAt);
  if (!Number.isFinite(time)) return null;
  const days = Math.max(0, Math.floor((now - time) / DAY_MS));
  return {
    date: new Date(time).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    }),
    age: days === 0 ? "less than a day ago" : days === 1 ? "1 day ago" : `${days} days ago`,
    days,
  };
}

// Reports stored before the audit-outcome split carried a note that called
// every unscored competitor a failed audit, including ones with no website.
// The counts below replace it, so it is not repeated.
const OVERSTATED_UNSCORED_NOTE = /remain unscored because no usable website audit/i;

/** "3 audit(s)" -> "3 audits", "1 record(s)" -> "1 record". */
function pluralizeNote(note: string): string {
  return note.replace(/\b(\d+) ([A-Za-z-]+)\(s\)/g, (_match, count: string, word: string) =>
    count === "1" ? `${count} ${word}` : `${count} ${word}s`
  );
}

export default function DataQualityBanner({
  dataQuality,
  user,
  competitors,
  generatedAt,
  now,
}: {
  dataQuality: DataQuality;
  user?: CompetitorReport;
  competitors?: CompetitorReport[];
  generatedAt?: string;
  now?: number;
}) {
  const outcomes = competitors ? countAuditOutcomes(competitors) : null;
  const userOutcome = user ? classifyAuditOutcome(user) : null;
  const age = describeReportAge(generatedAt, now);
  const notes = dataQuality.notes
    .filter((note) => !(outcomes && OVERSTATED_UNSCORED_NOTE.test(note)))
    .map(pluralizeNote);
  // Older saved reports carry no discovered count; they show the listed count only.
  const discoveredRow: Array<[string, number | string]> =
    dataQuality.discoveredCount !== undefined
      ? [
          [
            "Nearby businesses found",
            dataQuality.discoveryTruncated
              ? `${dataQuality.discoveredCount}+`
              : dataQuality.discoveredCount,
          ],
        ]
      : [];
  const counts: Array<[string, number | string]> = outcomes
    ? [
        ...discoveredRow,
        ["Businesses listed", dataQuality.realCompetitorsFound],
        ["Scored competitors", outcomes.scored],
        ["No website listed", outcomes.noWebsite],
        ["Website audit failed", outcomes.auditFailed],
        ["Not audited (report limit)", outcomes.notAttempted],
        ["Excluded chains", outcomes.excludedChains],
        ["Limited audits", dataQuality.limitedAudits],
      ]
    : [
        ...discoveredRow,
        ["Businesses listed", dataQuality.realCompetitorsFound],
        ["Scored competitors", dataQuality.scoredCompetitors],
        ["Limited audits", dataQuality.limitedAudits],
      ];

  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
      <p className="font-medium">
        This report uses real public data from OpenStreetMap, public websites,
        and, where available, public news sources. Unavailable evidence stays
        N/A rather than being replaced with estimated or demo values. Signals
        are directional, not verified internal company facts.
      </p>
      {age ? (
        <p className="mt-1 text-xs text-amber-900">
          Report generated{" "}
          <time dateTime={generatedAt}>{age.date}</time> ({age.age}). Source
          retrieval dates are listed in the Sources Appendix.
        </p>
      ) : null}
      {userOutcome && userOutcome.kind !== "scored" ? (
        <p className="mt-1 text-xs text-amber-900">
          Your {userOutcome.reason ?? "website audit was unavailable"}.
        </p>
      ) : null}
      {notes.length > 0 && (
        <ul className="mt-2 list-inside list-disc space-y-0.5 text-xs text-amber-900">
          {notes.map((note, idx) => (
            <li key={idx}>{note}</li>
          ))}
        </ul>
      )}
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-amber-900">
        {counts
          // Found/listed/scored always show; the breakdown rows only when non-zero.
          .filter(
            ([, value], index) =>
              index < discoveredRow.length + 2 || typeof value !== "number" || value > 0
          )
          .map(([label, value]) => (
            <span key={label}>
              {label}: {value}
            </span>
          ))}
        <span className="font-semibold capitalize">
          Coverage status: {dataQuality.coverageStatus}
        </span>
      </div>
    </div>
  );
}
