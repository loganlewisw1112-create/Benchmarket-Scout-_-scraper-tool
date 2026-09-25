import { NextResponse } from "next/server";
import { enforceGuard } from "@/lib/api-guard";
import { methodHandlers } from "@/lib/http";
import { logger, serializeError, withRequestId } from "@/lib/logger";
import { isMaintenanceMode, MAINTENANCE_RESPONSE } from "@/lib/maintenance";
import { REQUEST_ID_HEADER, requestIdFrom } from "@/lib/request-id";
import { isValidReportId, readReportV2 } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET also answers HEAD (Next derives it from GET).
const ALLOWED_METHODS = "GET, HEAD, OPTIONS";

// Shared report links are public (no access key), so reads are throttled per
// IP in their own 'reports' bucket: each lookup of an unknown id costs two
// KV reads, and this bounds how fast one client can spend that quota. A
// malformed id can never exist, so it is answered 404 before the guard and
// costs no KV command at all.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const requestId = requestIdFrom(request);
  const baseHeaders = { [REQUEST_ID_HEADER]: requestId };

  if (isMaintenanceMode()) {
    return NextResponse.json(MAINTENANCE_RESPONSE, {
      status: 503,
      headers: { ...baseHeaders, "Retry-After": "3600" },
    });
  }

  return withRequestId(requestId, async () => {
    const { id } = await params;
    if (!isValidReportId(id)) {
      return NextResponse.json(
        { error: "Report not found or expired.", code: "REPORT_NOT_FOUND" },
        { status: 404, headers: baseHeaders }
      );
    }
    const guard = await enforceGuard(request, { bucket: "reports" });
    if (!guard.ok) {
      logger.warn("report fetch rejected by guard", {
        status: guard.status,
        code: guard.code,
        retryAfterMs: guard.retryAfterMs,
      });
      const headers: Record<string, string> = { ...baseHeaders };
      if (guard.retryAfterMs !== undefined) {
        headers["Retry-After"] = String(Math.ceil(guard.retryAfterMs / 1000));
      }
      return NextResponse.json(
        { code: guard.code, error: guard.error },
        { status: guard.status, headers }
      );
    }

    try {
      const outcome = await readReportV2(id);
      if (outcome.status === "missing") {
        return NextResponse.json(
          { error: "Report not found or expired.", code: "REPORT_NOT_FOUND" },
          { status: 404, headers: baseHeaders }
        );
      }
      if (outcome.status === "legacy" || outcome.status === "invalid") {
        return NextResponse.json(
          {
            error:
              "This older report is unavailable because it does not meet Benchmark Scout's real-data-only provenance policy.",
            code: "LEGACY_REPORT_UNAVAILABLE",
          },
          { status: 410, headers: baseHeaders }
        );
      }
      return NextResponse.json(outcome.value, {
        status: 200,
        headers: baseHeaders,
      });
    } catch (err) {
      logger.error("report fetch failed", serializeError(err));
      return NextResponse.json(
        {
          error: "Stored reports are temporarily unavailable.",
          code: "SOURCE_UNAVAILABLE",
          retryable: true,
        },
        { status: 503, headers: { ...baseHeaders, "Retry-After": "60" } }
      );
    }
  });
}

// Explicit OPTIONS and JSON 405s so the advertised methods stay accurate
// (see lib/http.ts).
const { OPTIONS, methodNotAllowed } = methodHandlers(ALLOWED_METHODS);
export { OPTIONS };
export const POST = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
