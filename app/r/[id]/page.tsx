import { cache } from "react";
import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import ResultsDashboard from "@/components/ResultsDashboard";
import LegacyReportUnavailable from "@/components/LegacyReportUnavailable";
import MaintenancePage from "@/components/MaintenancePage";
import WaitlistForm from "@/components/WaitlistForm";
import { clientKeyFromHeaders, enforceGuardForKey } from "@/lib/api-guard";
import { isValidReportId, readReportV2 } from "@/lib/store";
import { isMaintenanceMode } from "@/lib/maintenance";
import { sharedReportMetadata } from "@/lib/share-metadata";
import { SITE_NAME } from "@/lib/site";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// readReportV2 hits the KV store / filesystem directly (not `fetch`), so it
// isn't covered by Next's automatic fetch memoization. Wrapping it in React's
// `cache()` dedupes the lookup between `generateMetadata` and the page
// component for a single request, avoiding a true double-fetch.
const getCachedReport = cache(readReportV2);

// Shared links are public, so page views are throttled per IP in the same
// 'reports' bucket as /api/reports/[id] (each unknown id costs KV reads).
// cache() makes generateMetadata and the page count as one request. A
// malformed id is a plain 404 checked before the guard, so it costs no KV.
const guardSharedReport = cache(async () =>
  enforceGuardForKey(clientKeyFromHeaders(await headers()), "reports")
);

function RateLimitedReport() {
  return (
    <main className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-6 py-16 text-center">
      <h1 className="text-2xl font-bold tracking-tight text-slate-900">
        Too many requests
      </h1>
      <p className="max-w-md text-sm text-slate-600">
        This connection has opened a lot of reports in the last minute. Please
        wait a minute and reload the page.
      </p>
    </main>
  );
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  if (isMaintenanceMode()) {
    return {
      title: `Maintenance | ${SITE_NAME}`,
      description: `${SITE_NAME} reports are temporarily unavailable during a real-data-only upgrade.`,
      robots: { index: false, follow: false },
    };
  }

  const { id } = await params;
  if (!isValidReportId(id)) {
    return {
      title: "Report not found",
      description: `This shared ${SITE_NAME} report is unavailable or may have expired.`,
      robots: { index: false, follow: false },
    };
  }
  const guard = await guardSharedReport();
  if (!guard.ok) {
    return {
      title: `Too many requests | ${SITE_NAME}`,
      robots: { index: false, follow: false },
    };
  }

  const stored = await getCachedReport(id);

  if (stored.status !== "ok") {
    if (stored.status === "missing") {
      return {
        title: "Report not found",
        description: `This shared ${SITE_NAME} report is unavailable or may have expired.`,
        robots: { index: false, follow: false },
      };
    }

    const title = `Report unavailable | ${SITE_NAME}`;
    const description = `This shared ${SITE_NAME} report cannot be displayed under the current verified-source standard.`;
    return sharedReportMetadata(id, title, description);
  }

  const data = stored.value.report;
  const businessName = data?.input?.businessName?.trim() || "This business";
  const marketLabel = data?.market?.label || data?.input?.market || "its market";

  const title =
    data?.report?.title || `${businessName} Competitor Report | ${SITE_NAME}`;
  const description = data?.report?.executiveSummary
    ? truncate(data.report.executiveSummary, 200)
    : `See how ${businessName} stacks up against local competitors in ${marketLabel}, benchmarked by ${SITE_NAME} from public web signals.`;

  return sharedReportMetadata(id, title, description);
}

export default async function SharedReportPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  if (isMaintenanceMode()) return <MaintenancePage />;
  const { id } = await params;
  if (!isValidReportId(id)) notFound();
  if (!(await guardSharedReport()).ok) return <RateLimitedReport />;

  const stored = await getCachedReport(id);
  if (stored.status !== "ok") {
    if (stored.status === "missing") notFound();
    return <LegacyReportUnavailable status={stored.status} />;
  }

  const data = stored.value.report;
  // The observations date from the analysis itself; a cached analysis can be
  // saved under a newer report id, so the stored createdAt would overstate
  // freshness.
  const generatedTime = Date.parse(data.generatedAt);
  const generated = new Date(
    Number.isFinite(generatedTime) ? generatedTime : stored.value.createdAt
  );
  const cachedAnalysis = data.dataQuality?.cacheHit === true;
  const marketLabel = data.market.label ? `${data.market.label} - ` : "";

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl flex-col gap-3 px-6 py-8 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-indigo-600">
              Shared report
            </p>
            <h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-900">
              {data.input.businessName}
            </h1>
            <p className="mt-1 text-sm text-slate-600">
              {marketLabel}
              Generated{" "}
              <time dateTime={generated.toISOString()}>
                {generated.toLocaleDateString(undefined, {
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                })}
              </time>
              {cachedAnalysis ? " (cached analysis)" : ""}
            </p>
          </div>
          <Link
            href="/"
            className="shrink-0 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-500"
          >
            Run your own report
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-6 px-6 py-8">
        <ResultsDashboard data={data} />
        <WaitlistForm source="shared-report" reportId={id} />
        <footer className="border-t border-slate-200 pt-6 text-xs leading-relaxed text-slate-600">
          <p>
            This is a read-only snapshot generated by Benchmark Scout from
            public web signals. Data reflects the moment the report was created
            and may since have changed.
          </p>
        </footer>
      </main>
    </div>
  );
}
