import { NextResponse } from "next/server";
import { enforceGuard } from "@/lib/api-guard";
import { logger, serializeError, withRequestId } from "@/lib/logger";
import { isMaintenanceMode, MAINTENANCE_RESPONSE } from "@/lib/maintenance";
import { REQUEST_ID_HEADER, requestIdFrom } from "@/lib/request-id";
import { sampleFreshness, selectRandomActiveSample } from "@/lib/sample-pool";
import { methodHandlers } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Same access-code gate as /api/analyze-market, with its own 'sample'
// rate-limit bucket. This route only reads a pre-generated real-data
// snapshot; it never runs the analysis pipeline.
export async function GET(request: Request) {
  // The proxy-forwarded id, so log lines and the response header match.
  const requestId = requestIdFrom(request);
  if (isMaintenanceMode()) {
    return NextResponse.json(MAINTENANCE_RESPONSE, {
      status: 503,
      headers: { "Retry-After": "3600", [REQUEST_ID_HEADER]: requestId },
    });
  }

  const startedAt = Date.now();

  return withRequestId(requestId, async () => {
    logger.info("sample-report request received", { method: request.method });

    const guard = await enforceGuard(request, { bucket: "sample" });
    if (!guard.ok) {
      logger.warn("sample-report rejected by guard", {
        status: guard.status,
        code: guard.code,
        retryAfterMs: guard.retryAfterMs,
      });
      const headers: Record<string, string> = { "x-request-id": requestId };
      if (guard.retryAfterMs !== undefined) {
        headers["Retry-After"] = String(Math.ceil(guard.retryAfterMs / 1000));
      }
      return NextResponse.json(
        { code: guard.code, error: guard.error },
        { status: guard.status, headers }
      );
    }

    try {
      const exclude = new URL(request.url).searchParams.get("exclude") ?? undefined;
      const snapshot = await selectRandomActiveSample(exclude);
      if (!snapshot) {
        logger.warn("sample-report unavailable", { exclude });
        return NextResponse.json(
          {
            code: "REAL_SAMPLE_UNAVAILABLE",
            error: "No current verified sample report is available.",
          },
          {
            status: 503,
            headers: { "Retry-After": "3600", "x-request-id": requestId },
          }
        );
      }

      const freshness = sampleFreshness(snapshot);
      logger.info("sample-report request completed", {
        durationMs: Date.now() - startedAt,
        status: 200,
        sampleId: snapshot.sampleId,
        reportId: snapshot.reportId,
        freshness,
      });

      return NextResponse.json(
        {
          sampleId: snapshot.sampleId,
          reportId: snapshot.reportId,
          generatedAt: snapshot.generatedAt,
          freshness,
          report: snapshot.report,
        },
        { status: 200, headers: { "x-request-id": requestId } }
      );
    } catch (err) {
      logger.error("sample-report failed", {
        ...serializeError(err),
        durationMs: Date.now() - startedAt,
      });
      return NextResponse.json(
        {
          code: "REAL_SAMPLE_UNAVAILABLE",
          error: "No current verified sample report is available.",
        },
        {
          status: 503,
          headers: { "Retry-After": "3600", "x-request-id": requestId },
        }
      );
    }
  });
}

// Unsupported methods get the shared JSON 405 with an accurate Allow header
// instead of Next's bare default (see lib/http.ts).
const { OPTIONS, methodNotAllowed } = methodHandlers("GET, HEAD, OPTIONS");
export { OPTIONS };
export const POST = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
