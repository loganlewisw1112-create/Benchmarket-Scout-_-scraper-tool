import { NextResponse } from "next/server";
import { isMaintenanceMode } from "@/lib/maintenance";
import { getSamplePoolHealth } from "@/lib/sample-pool";
import { isDurableStoreConfigured } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Liveness endpoint for uptime monitoring. Deliberately exempt from the
// rate limiter (monitors poll frequently) and deliberately unlogged
// (a log line per poll is noise). Unexpected throws are still captured
// generically by instrumentation.ts's onRequestError.
export async function GET() {
  const maintenance = isMaintenanceMode();
  const durableStoreConfigured = isDurableStoreConfigured();
  const hosted = process.env.VERCEL === "1" || Boolean(process.env.VERCEL_ENV);
  const durableStoreUnavailable = hosted && !durableStoreConfigured;
  if (durableStoreUnavailable) {
    return NextResponse.json(
      {
        status: maintenance ? "ok" : "degraded",
        maintenance,
        uptimeSeconds: process.uptime(),
        timestamp: new Date().toISOString(),
        durableStoreConfigured,
        activeSampleCount: 0,
        oldestSampleAgeHours: null,
        alert: true,
        alertReasons: [
          "DURABLE_STORE_UNAVAILABLE",
          "SAMPLE_STORE_UNAVAILABLE",
        ],
      },
      { status: maintenance ? 200 : 503 }
    );
  }
  try {
    const samples = await getSamplePoolHealth();
    return NextResponse.json({
      status: maintenance ? "ok" : samples.alert ? "degraded" : "ok",
      maintenance,
      uptimeSeconds: process.uptime(),
      timestamp: new Date().toISOString(),
      ...samples,
      durableStoreConfigured,
    });
  } catch {
    return NextResponse.json(
      {
        status: maintenance ? "ok" : "degraded",
        maintenance,
        uptimeSeconds: process.uptime(),
        timestamp: new Date().toISOString(),
        durableStoreConfigured,
        activeSampleCount: 0,
        oldestSampleAgeHours: null,
        alert: true,
        alertReasons: ["SAMPLE_STORE_UNAVAILABLE"],
      },
      { status: maintenance ? 200 : 503 }
    );
  }
}
