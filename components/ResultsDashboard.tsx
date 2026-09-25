import type { AnalyzeMarketResponse } from "@/lib/types";
import CompetitorTable from "./CompetitorTable";
import DataQualityBanner, { describeReportAge } from "./DataQualityBanner";
import RecommendationPanel from "./RecommendationPanel";
import ReportCard from "./ReportCard";
import ScoreCards from "./ScoreCards";
import SignalPanel from "./SignalPanel";
import SourcesAppendix from "./ProvenanceDetails";

export default function ResultsDashboard({
  data,
  sampleFreshness = null,
  now,
}: {
  data: AnalyzeMarketResponse;
  sampleFreshness?: "active" | "retained" | null;
  /** Reference time for the "N days ago" labels (tests pin it). */
  now?: number;
}) {
  const age = describeReportAge(data.generatedAt, now);
  return (
    <div className="space-y-6">
      {sampleFreshness === "retained" ? (
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
          Showing a retained real sample while fresh samples refresh. Numbers
          are from a verified live run
          {age ? (
            <>
              {" "}
              on <time dateTime={data.generatedAt}>{age.date}</time> ({age.age})
            </>
          ) : null}
          .
        </div>
      ) : null}
      <ReportCard data={data} />
      <DataQualityBanner
        dataQuality={data.dataQuality}
        user={data.user}
        competitors={data.competitors}
        generatedAt={data.generatedAt}
        now={now}
      />
      <ScoreCards
        user={data.user}
        summary={data.summary}
        competitors={data.competitors}
      />

      <div>
        <h3 className="mb-2 text-sm font-semibold text-slate-900">
          Local Competitor Landscape
        </h3>
        <CompetitorTable user={data.user} competitors={data.competitors} />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <SignalPanel user={data.user} competitors={data.competitors} />
        <RecommendationPanel
          recommendations={data.recommendations}
          emptyStatement={data.report.actionPlanNote}
        />
      </div>
      <SourcesAppendix sources={data.provenance.sources} />
    </div>
  );
}
