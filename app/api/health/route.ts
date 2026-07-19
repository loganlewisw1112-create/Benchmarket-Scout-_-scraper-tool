import { NextResponse } from "next/server";
import { isMaintenanceMode } from "@/lib/maintenance";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Liveness endpoint for uptime monitoring. Deliberately exempt from the
// rate limiter (monitors poll frequently) and deliberately unlogged
// (a log line per poll is noise). Unexpected throws are still captured
// generically by instrumentation.ts's onRequestError.
export async function GET() {
  return NextResponse.json({
    status: "ok",
    maintenance: isMaintenanceMode(),
    uptimeSeconds: process.uptime(),
    timestamp: new Date().toISOString(),
  });
}
