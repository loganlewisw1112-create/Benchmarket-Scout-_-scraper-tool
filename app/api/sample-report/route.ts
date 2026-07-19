import { NextResponse } from "next/server";
import { enforceGuard } from "@/lib/api-guard";
import { logger, serializeError, withRequestId } from "@/lib/logger";
import { isMaintenanceMode, MAINTENANCE_RESPONSE } from "@/lib/maintenance";
import { selectRandomActiveSample } from "@/lib/sample-pool";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Same access-code + rate-limit gate as /api/analyze-market. This route only
// reads a pre-generated real-data snapshot; it never runs the analysis pipeline.
export async function GET(request: Request) {
  if (isMaintenanceMode()) {
    return NextResponse.json(MAINTENANCE_RESPONSE, {
      status: 503,
      headers: { "Retry-After": "3600" },
    });
  }

  const requestId = crypto.randomUUID();
  const startedAt = Date.now();

  return withRequestId(requestId, async () => {
    logger.info("sample-report request received", { method: request.method });

    const guard = await enforceGuard(request);
    if (!guard.ok) {
      logger.warn("sample-report rejected by guard", {
        status: guard.status,
        retryAfterMs: guard.retryAfterMs,
      });
      const headers: Record<string, string> = { "x-request-id": requestId };
      if (guard.retryAfterMs !== undefined) {
        headers["Retry-After"] = String(Math.ceil(guard.retryAfterMs / 1000));
      }
      return NextResponse.json(
        { error: guard.error },
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

      logger.info("sample-report request completed", {
        durationMs: Date.now() - startedAt,
        status: 200,
        sampleId: snapshot.sampleId,
        reportId: snapshot.reportId,
      });

      return NextResponse.json(
        {
          sampleId: snapshot.sampleId,
          reportId: snapshot.reportId,
          generatedAt: snapshot.generatedAt,
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
