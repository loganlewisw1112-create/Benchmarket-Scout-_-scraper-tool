import { NextResponse } from "next/server";
import { enforceGuard } from "@/lib/api-guard";
import { logger, serializeError, withRequestId } from "@/lib/logger";
import { generateSampleReport } from "@/lib/sample-report";
import { saveReport } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Same access-code + rate-limit gate as /api/analyze-market. No request
// body — every call is a fresh, randomly generated sample.
export async function GET(request: Request) {
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
      const result = await generateSampleReport();

      // Persist for the shareable read-only view, same as a real analysis.
      // Best-effort: a store failure must never break the sample response.
      let reportId: string | undefined;
      try {
        reportId = await saveReport(result);
      } catch (err) {
        logger.warn("sample-report save failed", serializeError(err));
      }

      logger.info("sample-report request completed", {
        durationMs: Date.now() - startedAt,
        status: 200,
        businessType: result.input.businessType,
        market: result.input.market,
        reportSaved: reportId !== undefined,
      });

      return NextResponse.json(
        { ...result, reportId },
        { status: 200, headers: { "x-request-id": requestId } }
      );
    } catch (err) {
      logger.error("sample-report failed", {
        ...serializeError(err),
        durationMs: Date.now() - startedAt,
      });
      return NextResponse.json(
        { error: "Could not generate a sample report. Please try again." },
        { status: 500, headers: { "x-request-id": requestId } }
      );
    }
  });
}
