import DownloadPdfButton from "./DownloadPdfButton";
import { buildDataQualityNote } from "@/lib/report";
import type { AnalyzeMarketResponse, ReportFinding } from "@/lib/types";
import { CitationMarkers } from "./ProvenanceDetails";
import { DEFAULT_EMPTY_ACTION_PLAN } from "./RecommendationPanel";
import { displayStatus, rankText } from "./ScoreCards";

const POSITION_FINDING_TITLE = "Observed market position";

function signedMetric(value: number | null): string {
  if (value === null) return "N/A";
  return `${value > 0 ? "+" : ""}${value || 0}`;
}

/**
 * The on-screen top three always include the market-position finding (the
 * PDF prints it too). Older stored reports listed it last, after up to three
 * category findings, so it is moved to the front here.
 */
export function topFindingsForDisplay(findings: ReportFinding[]): ReportFinding[] {
  const position = findings.filter((f) => f.title === POSITION_FINDING_TITLE);
  const rest = findings.filter((f) => f.title !== POSITION_FINDING_TITLE);
  return [...position, ...rest].slice(0, 3);
}

export default function ReportCard({ data }: { data: AnalyzeMarketResponse }) {
  const { report, summary, dataQuality } = data;
  const status = displayStatus(summary);
  const dataQualityNote = buildDataQualityNote({
    user: data.user,
    competitors: data.competitors,
    dataQuality,
  });

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">
            {report.title}
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            {report.positionStatement}
          </p>
        </div>
        <DownloadPdfButton reportData={data} />
      </div>

      <div className="mt-5 grid grid-cols-1 gap-5 md:grid-cols-3">
        <div className="md:col-span-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-600">
            Executive Summary
          </h3>
          <p className="mt-1.5 text-sm leading-relaxed text-slate-700">
            {report.executiveSummary}
          </p>

          <h3 className="mt-4 text-xs font-semibold uppercase tracking-wide text-slate-600">
            Top 3 Findings
          </h3>
          <ul className="mt-1.5 space-y-2">
            {topFindingsForDisplay(report.topFindings).map((f, idx) => (
              <li key={idx} className="text-sm text-slate-700">
                <span className="font-medium text-slate-900">{f.title}:</span>{" "}
                {f.finding}
                <CitationMarkers sourceIds={f.sourceIds} />
                <span className="ml-1.5 text-xs text-slate-600">
                  ({f.confidence} confidence)
                </span>
              </li>
            ))}
          </ul>

          {report.topRisks.length > 0 && (
            <>
              <h3 className="mt-4 text-xs font-semibold uppercase tracking-wide text-slate-600">
                Possible Risks / Changes
              </h3>
              <ul className="mt-1.5 space-y-2">
                {report.topRisks.slice(0, 5).map((risk, idx) => (
                  <li key={idx} className="text-sm text-slate-700">
                    <span className="font-medium text-slate-900">
                      {risk.title}:
                    </span>{" "}
                    {risk.finding}
                    <CitationMarkers sourceIds={risk.sourceIds} />
                    <span className="ml-1.5 text-xs text-slate-600">
                      ({risk.confidence} confidence)
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>

        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-600">
            Local Position
          </h3>
          <dl className="mt-1.5 space-y-1 text-sm">
            <div className="flex justify-between">
              <dt className="text-slate-600">Status</dt>
              <dd className="font-medium capitalize text-slate-900">
                {status ?? "N/A"}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-600">Rank</dt>
              <dd className="font-medium text-slate-900">
                {rankText(summary, data.user)}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-600">Market gap</dt>
              <dd className="font-medium text-slate-900">
                {signedMetric(summary.marketGap)}
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-slate-600">Competitor avg.</dt>
              <dd className="font-medium text-slate-900">
                {summary.competitorAverageFinalScore === null
                  ? "N/A"
                  : `${summary.competitorAverageFinalScore}/100`}
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-slate-600">Avg. website</dt>
              <dd className="font-medium text-slate-900">
                {summary.competitorAverageWebsiteScore === null
                  ? "N/A"
                  : `${summary.competitorAverageWebsiteScore}/100`}
              </dd>
            </div>
          </dl>

          <h3 className="mt-4 text-xs font-semibold uppercase tracking-wide text-slate-600">
            Top 5 Recommended Actions
          </h3>
          {report.actionPlan.length === 0 ? (
            <p className="mt-1.5 text-sm text-slate-700">
              {report.actionPlanNote ?? DEFAULT_EMPTY_ACTION_PLAN}
            </p>
          ) : (
            <ol className="mt-1.5 list-decimal space-y-1 pl-4 text-sm text-slate-700">
              {report.actionPlan.slice(0, 5).map((rec, idx) => (
                <li key={idx}>
                  {rec.title}
                  <CitationMarkers sourceIds={rec.sourceIds} />
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>

      <div className="mt-5 border-t border-slate-100 pt-3 text-xs text-slate-600">
        <span className="font-medium">Data quality:</span> {dataQualityNote}
        <span className="ml-1.5 font-semibold capitalize text-amber-800">
          Coverage status: {dataQuality.coverageStatus}.
        </span>
      </div>
    </div>
  );
}
