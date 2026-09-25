"use client";

import { useEffect, useState } from "react";

// End-user view of /api/health: when the service reports "degraded", say
// which parts are affected instead of letting people find out by failing.
// Silent while healthy, in maintenance (the page itself says so), or when
// the health check cannot be read.

const REASON_TEXT: Record<string, string> = {
  DURABLE_STORE_UNAVAILABLE:
    "Report storage is unavailable, so new reports may not be saved or shareable.",
  ACTIVE_SAMPLES_LOW: "Fewer verified sample reports than usual are available.",
  SERVED_SAMPLES_STALE: "Sample reports are older than usual.",
};

export function describeDegradedHealth(body: unknown): string[] | null {
  if (!body || typeof body !== "object") return null;
  const { status, alertReasons } = body as { status?: unknown; alertReasons?: unknown };
  if (status !== "degraded") return null;
  const reasons = Array.isArray(alertReasons)
    ? alertReasons.filter((reason): reason is string => typeof reason === "string")
    : [];
  const lines = reasons.map((reason) => REASON_TEXT[reason]).filter(Boolean);
  return lines.length > 0 ? lines : ["Some features may not work as expected."];
}

export default function ServiceStatusBanner() {
  const [lines, setLines] = useState<string[] | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/health", { signal: controller.signal, cache: "no-store" })
      .then((res) => res.json())
      .then((body: unknown) => setLines(describeDegradedHealth(body)))
      .catch(() => {
        // An unreadable health check says nothing reliable; show nothing.
      });
    return () => controller.abort();
  }, []);

  if (!lines) return null;
  return (
    <div
      role="status"
      className="border-b border-amber-200 bg-amber-50 px-6 py-2 text-center text-sm text-amber-900"
    >
      <span className="font-medium">Benchmark Scout is partly degraded right now.</span>{" "}
      {lines.join(" ")}
    </div>
  );
}
