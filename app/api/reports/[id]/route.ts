import { NextResponse } from "next/server";
import { logger, serializeError } from "@/lib/logger";
import { isMaintenanceMode, MAINTENANCE_RESPONSE } from "@/lib/maintenance";
import { readReportV2 } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (isMaintenanceMode()) {
    return NextResponse.json(MAINTENANCE_RESPONSE, {
      status: 503,
      headers: { "Retry-After": "3600" },
    });
  }

  const { id } = await params;
  try {
    const outcome = await readReportV2(id);
    if (outcome.status === "missing") {
      return NextResponse.json(
        { error: "Report not found or expired.", code: "REPORT_NOT_FOUND" },
        { status: 404 }
      );
    }
    if (outcome.status === "legacy" || outcome.status === "invalid") {
      return NextResponse.json(
        {
          error:
            "This older report is unavailable because it does not meet Benchmark Scout's real-data-only provenance policy.",
          code: "LEGACY_REPORT_UNAVAILABLE",
        },
        { status: 410 }
      );
    }
    return NextResponse.json(outcome.value, { status: 200 });
  } catch (err) {
    logger.error("report fetch failed", serializeError(err));
    return NextResponse.json(
      {
        error: "Stored reports are temporarily unavailable.",
        code: "SOURCE_UNAVAILABLE",
        retryable: true,
      },
      { status: 503, headers: { "Retry-After": "60" } }
    );
  }
}
