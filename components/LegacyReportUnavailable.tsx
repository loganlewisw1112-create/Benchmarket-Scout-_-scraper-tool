import Link from "next/link";

export default function LegacyReportUnavailable({
  status,
}: {
  status: "legacy" | "invalid";
}) {
  const isLegacy = status === "legacy";

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-slate-50 px-6 text-center">
      <p className="text-xs font-medium uppercase tracking-wide text-indigo-600">
        Shared report
      </p>
      <h1 className="text-2xl font-bold tracking-tight text-slate-900">
        This report cannot be displayed safely
      </h1>
      <p className="max-w-lg text-sm leading-relaxed text-slate-600">
        {isLegacy
          ? "This report was created before Benchmark Scout required verified real-world sources and complete citations. Its old values are preserved, but they are not shown as current evidence."
          : "This report does not pass Benchmark Scout's current verified-source validation, so its values are not shown as trustworthy evidence."}
      </p>
      <p className="max-w-lg text-sm text-slate-600">
        Run a new report to receive the real-data-only format with citation
        markers and a complete sources appendix.
      </p>
      <Link
        href="/"
        className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-500"
      >
        Run a new report
      </Link>
    </div>
  );
}
