import { NextResponse } from "next/server";
import { isMaintenanceMode } from "@/lib/maintenance";
import { getSamplePoolHealth, type SamplePoolHealth } from "@/lib/sample-pool";
import { isDurableStoreConfigured, isPreviewKvBlocked } from "@/lib/store";
import { methodHandlers } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type HealthAlertReason =
  | SamplePoolHealth["alertReasons"][number]
  | "DURABLE_STORE_UNAVAILABLE";

// A 200 may be shared by the CDN for 30s (matching the in-process memo in
// lib/sample-pool.ts); a 503 must never be cached.
const OK_CACHE_CONTROL = "public, s-maxage=30, stale-while-revalidate=30";
const FAILING_CACHE_CONTROL = "no-store";

const EMPTY_POOL = {
  activeSampleCount: 0,
  servedSampleCount: 0,
  servingRetained: false,
  oldestSampleAgeHours: null,
  newestSampleAgeHours: null,
  catalog: null,
} as const;

// Liveness/readiness endpoint for uptime monitoring. It measures only the
// served sample pool (see lib/sample-pool.ts) and the durable store, reading
// small per-catalog metadata records rather than full snapshots. Exempt from
// the rate limiter (monitors poll it) and deliberately unlogged (a log line
// per poll is noise). Unexpected throws are still captured generically by
// instrumentation.ts's onRequestError.
//
// HTTP: 200 when ok; 503 when any alert fires. During maintenance the
// endpoint answers 200 with maintenance:true (DEPLOY.md runbook) but still
// reports whatever alerts it computed, so store problems stay visible.
export async function GET() {
  const maintenance = isMaintenanceMode();
  const durableStoreConfigured = isDurableStoreConfigured();
  const previewKvBlocked = isPreviewKvBlocked();
  const hosted = process.env.VERCEL === "1" || Boolean(process.env.VERCEL_ENV);
  const timestamp = new Date().toISOString();

  let pool: SamplePoolHealth | null = null;
  let storeUnavailable = hosted && !durableStoreConfigured && !previewKvBlocked;
  if (!storeUnavailable) {
    try {
      pool = await getSamplePoolHealth();
    } catch {
      storeUnavailable = true;
    }
  }

  const alertReasons: HealthAlertReason[] = storeUnavailable
    ? ["DURABLE_STORE_UNAVAILABLE"]
    : [...(pool?.alertReasons ?? [])];
  const alert = alertReasons.length > 0;
  const status = maintenance ? "maintenance" : alert ? "degraded" : "ok";
  const httpStatus = maintenance || !alert ? 200 : 503;

  return NextResponse.json(
    {
      status,
      maintenance,
      uptimeSeconds: process.uptime(),
      timestamp,
      durableStoreConfigured,
      ...(previewKvBlocked ? { previewKvBlocked } : {}),
      ...(pool ?? EMPTY_POOL),
      alert,
      alertReasons,
    },
    {
      status: httpStatus,
      headers: {
        "Cache-Control":
          httpStatus === 200 ? OK_CACHE_CONTROL : FAILING_CACHE_CONTROL,
      },
    }
  );
}

// Unsupported methods get the shared JSON 405 with an accurate Allow header
// instead of Next's bare default (see lib/http.ts).
const { OPTIONS, methodNotAllowed } = methodHandlers("GET, HEAD, OPTIONS");
export { OPTIONS };
export const POST = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
