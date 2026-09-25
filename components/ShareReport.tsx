"use client";

import { useState } from "react";

// Renders a copyable link to the persisted read-only report. Renders nothing
// when the report was not persisted (no id), so the UI degrades gracefully if
// the durable store is unavailable.
export default function ShareReport({ reportId }: { reportId?: string }) {
  const [copied, setCopied] = useState(false);

  if (!reportId) return null;

  const shareUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/r/${reportId}`
      : `/r/${reportId}`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked (e.g. insecure context); select-to-copy still works.
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-slate-200 bg-white p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="text-sm font-semibold text-slate-900">
          Share this report
        </p>
        <p className="truncate text-xs text-slate-600">{shareUrl}</p>
      </div>
      <button
        type="button"
        onClick={copy}
        className="shrink-0 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
      >
        {copied ? "Copied!" : "Copy link"}
      </button>
    </div>
  );
}
