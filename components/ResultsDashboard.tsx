import type { AnalyzeMarketResponse } from "@/lib/types";
import CompetitorTable from "./CompetitorTable";
import DataQualityBanner from "./DataQualityBanner";
import RecommendationPanel from "./RecommendationPanel";
import ReportCard from "./ReportCard";
import ScoreCards from "./ScoreCards";
import SignalPanel from "./SignalPanel";
import SourcesAppendix from "./ProvenanceDetails";

export default function ResultsDashboard({
  data,
  sampleFreshness = null,
}: {
  data: AnalyzeMarketResponse;
  sampleFreshness?: "active" | "retained" | null;
}) {
  return (
    <div className="space-y-6">
      {sampleFreshness === "retained" ? (
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
          Showing a retained real sample while fresh samples refresh. Numbers
          are still from a verified live run — just older than 72 hours.
        </div>
      ) : null}
      <ReportCard data={data} />
      <DataQualityBanner dataQuality={data.dataQuality} />
      <ScoreCards user={data.user} summary={data.summary} />

      <div>
        <h3 className="mb-2 text-sm font-semibold text-slate-900">
          Local Competitor Landscape
        </h3>
        <CompetitorTable user={data.user} competitors={data.competitors} />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <SignalPanel user={data.user} competitors={data.competitors} />
        <RecommendationPanel recommendations={data.recommendations} />
      </div>
      <SourcesAppendix sources={data.provenance.sources} />
    </div>
  );
}
