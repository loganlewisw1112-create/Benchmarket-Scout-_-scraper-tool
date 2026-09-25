import type { CompetitorReport, MarketSignal } from "@/lib/types";
import { CitationMarkers } from "./ProvenanceDetails";

function ConfidenceBadge({ confidence }: { confidence: MarketSignal["confidence"] }) {
  const styles = {
    high: "bg-emerald-100 text-emerald-700",
    medium: "bg-blue-100 text-blue-700",
    low: "bg-slate-100 text-slate-700",
  } as const;
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${styles[confidence]}`}>
      {confidence} confidence
    </span>
  );
}

type FlatSignal = {
  businessName: string;
  category: string;
  signal: MarketSignal;
};

function flattenSignals(
  user: CompetitorReport,
  competitors: CompetitorReport[]
): FlatSignal[] {
  const all = [user, ...competitors];
  const flat: FlatSignal[] = [];

  const categories: Array<[string, (c: CompetitorReport) => MarketSignal[]]> = [
    ["Momentum", (c) => c.signals.momentumSignals],
    ["Offer", (c) => c.signals.offerSignals],
    ["Hiring", (c) => c.signals.hiringSignals],
    ["News", (c) => c.signals.newsSignals],
    ["Risk", (c) => c.signals.riskSignals],
    ["Company change", (c) => c.signals.changeSignals],
  ];

  for (const business of all) {
    for (const [category, getter] of categories) {
      for (const signal of getter(business)) {
        flat.push({ businessName: business.name, category, signal });
      }
    }
  }

  return flat;
}

export default function SignalPanel({
  user,
  competitors,
}: {
  user: CompetitorReport;
  competitors: CompetitorReport[];
}) {
  const signals = flattenSignals(user, competitors).slice(0, 12);
  const records = [user, ...competitors];
  const newsObserved = records.some(
    (record) => record.signals.newsStatus === "complete"
  );
  const newsUnavailable = records.some(
    (record) => record.signals.newsStatus === "unavailable"
  );

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <h3 className="text-sm font-semibold text-slate-900">
        Signal Intelligence
      </h3>
      <p className="mt-1 text-xs text-slate-600">
        Public signals observed on homepages, linked pages, and public news —
        directional, not verified internal facts.
      </p>
      {!newsObserved && newsUnavailable ? (
        <p className="mt-1 text-xs text-slate-600">
          News search was unavailable for this report, so news is N/A (not
          zero) for every business.
        </p>
      ) : null}

      {signals.length === 0 ? (
        <p className="mt-4 text-sm text-slate-600">
          No public momentum, risk, offer, or hiring signals were detected in
          this run.
        </p>
      ) : (
        <ul className="mt-4 space-y-2">
          {signals.map((item, idx) => (
            <li
              key={idx}
              className="flex flex-col gap-1 rounded-lg border border-slate-100 bg-slate-50 px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
            >
              <div>
                <span className="text-xs font-semibold text-slate-700">
                  {item.businessName}
                </span>
                <span aria-hidden="true" className="mx-1.5 text-slate-500">
                  ·
                </span>
                <span className="text-xs font-medium text-indigo-700">
                  {item.category}
                </span>
                <p className="mt-0.5 text-xs text-slate-700">
                  {item.signal.evidence}
                  <CitationMarkers sourceIds={item.signal.sourceIds} />
                </p>
              </div>
              <ConfidenceBadge confidence={item.signal.confidence} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
