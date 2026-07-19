import type { Metadata } from "next";
import Link from "next/link";

// Next.js discards a route segment's own `generateMetadata` output once that
// segment calls `notFound()` — only this file's `metadata` export (merged
// with ancestor layouts) is used for the rendered <head> in that case. See
// node_modules/next/dist/docs/01-app/03-api-reference/04-functions/not-found.md.
export const metadata: Metadata = {
  title: "Report not found",
  description:
    "This shared Benchmark Scout report is unavailable or may have expired.",
  robots: { index: false, follow: false },
  openGraph: {
    title: "Report not found",
    description:
      "This shared Benchmark Scout report is unavailable or may have expired.",
    siteName: "Benchmark Scout",
    type: "website",
  },
};

export default function SharedReportNotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-slate-50 px-6 text-center">
      <p className="text-xs font-medium uppercase tracking-wide text-indigo-600">
        Shared report
      </p>
      <h1 className="text-2xl font-bold tracking-tight text-slate-900">
        Report not found
      </h1>
      <p className="max-w-md text-sm text-slate-500">
        This link may be broken, or the report may have expired.
      </p>
      <Link
        href="/"
        className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-500"
      >
        Run your own report
      </Link>
    </div>
  );
}
