"use client";

import { useEffect, useState } from "react";

const STEPS = [
  "Finding local competitors…",
  "Auditing public websites…",
  "Scanning public market signals…",
  "Ranking the local market…",
  "Generating concise report…",
  "Preparing PDF-ready output…",
];

export default function LoadingSteps() {
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setActiveIndex((idx) => (idx < STEPS.length - 1 ? idx + 1 : idx));
    }, 1400);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
      <div className="mx-auto max-w-md space-y-3">
        {STEPS.map((step, idx) => (
          <div key={step} className="flex items-center gap-3">
            <span
              className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px] ${
                idx < activeIndex
                  ? "border-emerald-500 bg-emerald-500 text-white"
                  : idx === activeIndex
                  ? "border-indigo-500 text-indigo-500"
                  : "border-slate-300 text-slate-300"
              }`}
            >
              {idx < activeIndex ? "✓" : idx === activeIndex ? "•" : ""}
            </span>
            <span
              className={`text-sm ${
                idx <= activeIndex ? "text-slate-800" : "text-slate-400"
              }`}
            >
              {step}
            </span>
            {idx === activeIndex && (
              <span className="ml-auto h-3.5 w-3.5 animate-spin rounded-full border-2 border-indigo-200 border-t-indigo-600" />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
