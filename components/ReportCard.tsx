import DownloadPdfButton from "./DownloadPdfButton";
import type { AnalyzeMarketResponse } from "@/lib/types";

export default function ReportCard({ data }: { data: AnalyzeMarketResponse }) {
  const { report, summary, dataQuality } = data;

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
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Executive Summary
          </h3>
          <p className="mt-1.5 text-sm leading-relaxed text-slate-700">
            {report.executiveSummary}
          </p>

          <h3 className="mt-4 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Top 3 Findings
          </h3>
          <ul className="mt-1.5 space-y-2">
            {report.topFindings.slice(0, 3).map((f, idx) => (
              <li key={idx} className="text-sm text-slate-700">
                <span className="font-medium text-slate-900">{f.title}:</span>{" "}
                {f.finding}
                <span className="ml-1.5 text-xs text-slate-400">
                  ({f.confidence} confidence)
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Local Position
          </h3>
          <dl className="mt-1.5 space-y-1 text-sm">
            <div className="flex justify-between">
              <dt className="text-slate-500">Status</dt>
              <dd className="font-medium capitalize text-slate-900">
                {summary.status}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-500">Rank</dt>
              <dd className="font-medium text-slate-900">
                #{summary.yourRank} of {summary.competitorCount + 1}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-500">Market gap</dt>
              <dd className="font-medium text-slate-900">
                {summary.marketGap >= 0 ? "+" : ""}
                {summary.marketGap}
              </dd>
            </div>
          </dl>

          <h3 className="mt-4 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Top 5 Recommended Actions
          </h3>
          <ol className="mt-1.5 list-decimal space-y-1 pl-4 text-sm text-slate-700">
            {report.actionPlan.slice(0, 5).map((rec, idx) => (
              <li key={idx}>{rec.title}</li>
            ))}
          </ol>
        </div>
      </div>

      <div className="mt-5 border-t border-slate-100 pt-3 text-xs text-slate-500">
        <span className="font-medium">Data quality:</span>{" "}
        {report.dataQualityNote}
        {dataQuality.usedMockData && (
          <span className="ml-1.5 font-semibold text-purple-700">
            Includes labeled fallback demo rows.
          </span>
        )}
      </div>
    </div>
  );
}
