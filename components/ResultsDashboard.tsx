import type { AnalyzeMarketResponse } from "@/lib/types";
import CompetitorTable from "./CompetitorTable";
import DataQualityBanner from "./DataQualityBanner";
import RecommendationPanel from "./RecommendationPanel";
import ReportCard from "./ReportCard";
import ScoreCards from "./ScoreCards";
import SignalPanel from "./SignalPanel";

export default function ResultsDashboard({
  data,
}: {
  data: AnalyzeMarketResponse;
}) {
  return (
    <div className="space-y-6">
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
    </div>
  );
}
