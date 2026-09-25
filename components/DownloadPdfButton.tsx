"use client";

import { useState } from "react";
import type { AnalyzeMarketResponse } from "@/lib/types";

export default function DownloadPdfButton({
  reportData,
}: {
  reportData: AnalyzeMarketResponse;
}) {
  const [state, setState] = useState<"idle" | "generating" | "error">("idle");

  async function handleClick() {
    setState("generating");
    try {
      // Loaded on click so jsPDF/autotable stay out of the page bundle; the
      // await also lets the "Preparing PDF..." label paint before the
      // (synchronous, potentially heavy) layout work blocks the thread.
      const { downloadBenchmarkPdf } = await import("@/lib/pdf");
      await new Promise((resolve) => setTimeout(resolve, 30));
      await downloadBenchmarkPdf(reportData);
      setState("idle");
    } catch (err) {
      console.error("PDF export failed", err);
      setState("error");
    }
  }

  return (
    <div className="flex flex-col items-start gap-1.5">
      <button
        type="button"
        onClick={handleClick}
        disabled={state === "generating"}
        className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {state === "generating" ? (
          <>
            <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" />
            Preparing PDF…
          </>
        ) : (
          <>Download PDF Report</>
        )}
      </button>
      {state === "error" && (
        <p className="text-xs text-red-600">
          PDF export failed. The dashboard report is still available.
        </p>
      )}
    </div>
  );
}
