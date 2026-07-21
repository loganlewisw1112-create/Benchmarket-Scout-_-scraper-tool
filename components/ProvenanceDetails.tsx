import { Fragment } from "react";
import type { SourceId, SourceReference } from "@/lib/types";

export function CitationMarkers({
  sourceIds,
}: {
  sourceIds: readonly SourceId[];
}) {
  if (sourceIds.length === 0) return null;

  // Findings can cite 20+ sources. `whitespace-nowrap` must stay scoped to a
  // single marker so "[S12]" never splits across lines; applying it to the
  // whole run made it one unbreakable inline box that overflowed its grid
  // column and painted over the neighbouring column. The explicit spaces
  // between markers are the wrap opportunities.
  return (
    <span
      className="ml-1 text-xs font-medium text-indigo-600"
      aria-label={`Sources ${sourceIds.join(", ")}`}
    >
      {sourceIds.map((sourceId, idx) => (
        <Fragment key={sourceId}>
          {idx > 0 ? " " : null}
          <span className="whitespace-nowrap">[{sourceId}]</span>
        </Fragment>
      ))}
    </span>
  );
}

function safeSourceUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

export default function SourcesAppendix({
  sources,
}: {
  sources: readonly SourceReference[];
}) {
  return (
    <section
      aria-labelledby="sources-appendix-title"
      className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
    >
      <h3
        id="sources-appendix-title"
        className="text-sm font-semibold text-slate-900"
      >
        Sources Appendix
      </h3>
      <p className="mt-1 text-xs text-slate-500">
        Every source captured with this report. Citation markers above map to
        these stable source IDs.
      </p>

      <div className="mt-4 overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-200 text-left text-xs">
          <thead className="bg-slate-50 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-2">ID</th>
              <th className="px-3 py-2">Provider</th>
              <th className="px-3 py-2">Entity</th>
              <th className="px-3 py-2">URL</th>
              <th className="px-3 py-2">Access time</th>
              <th className="px-3 py-2">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 text-slate-700">
            {sources.map((source) => {
              const sourceUrl = safeSourceUrl(source.url);
              return (
                <tr key={source.id}>
                  <td className="whitespace-nowrap px-3 py-2 font-semibold text-indigo-700">
                    [{source.id}]
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">
                    {source.provider}
                  </td>
                  <td className="min-w-48 px-3 py-2">
                    <span>{source.businessName ?? source.title}</span>
                    {source.businessName && source.title !== source.businessName && (
                      <span className="mt-0.5 block text-[11px] text-slate-500">
                        {source.title}
                      </span>
                    )}
                  </td>
                  <td className="max-w-72 break-all px-3 py-2">
                    {sourceUrl ? (
                      <a
                        href={sourceUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-indigo-600 underline decoration-indigo-200 underline-offset-2 hover:text-indigo-800"
                      >
                        {sourceUrl}
                      </a>
                    ) : (
                      source.url ?? "N/A"
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">
                    <time dateTime={source.accessedAt}>
                      {source.accessedAt}
                    </time>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 capitalize">
                    {source.status}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
