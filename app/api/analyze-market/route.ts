import { NextResponse } from "next/server";
import { analyzeMarket } from "@/lib/analyze-market";
import { enforceGlobalAnalyzeLimit, enforceGuard } from "@/lib/api-guard";
import { logger, serializeError, withRequestId } from "@/lib/logger";
import { isMaintenanceMode, MAINTENANCE_RESPONSE } from "@/lib/maintenance";
import { saveReport } from "@/lib/store";
import { validateAnalyzeMarketRequest } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  if (isMaintenanceMode()) {
    return NextResponse.json(MAINTENANCE_RESPONSE, {
      status: 503,
      headers: { "Retry-After": "3600" },
    });
  }

  const requestId = crypto.randomUUID();
  const startedAt = Date.now();

  // Everything inside this scope, including the whole lib/ pipeline,
  // automatically carries requestId on its structured log lines.
  return withRequestId(requestId, async () => {
    logger.info("analyze-market request received", { method: request.method });

    const guard = await enforceGuard(request);
    if (!guard.ok) {
      logger.warn("analyze-market rejected by guard", {
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

    let body: unknown;

    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: "Request body must be valid JSON." },
        { status: 400, headers: { "x-request-id": requestId } }
      );
    }

    const parsed = validateAnalyzeMarketRequest(body);

    if (!parsed.success) {
      return NextResponse.json(
        {
          error: "Invalid input.",
          details: parsed.error.flatten().fieldErrors,
        },
        { status: 400, headers: { "x-request-id": requestId } }
      );
    }

    const globalLimit = await enforceGlobalAnalyzeLimit();
    if (!globalLimit.ok) {
      logger.warn("analyze-market rejected by global limit", {
        retryAfterMs: globalLimit.retryAfterMs,
      });
      return NextResponse.json(
        { error: globalLimit.error },
        {
          status: globalLimit.status,
          headers: {
            "x-request-id": requestId,
            "Retry-After": String(Math.ceil(globalLimit.retryAfterMs / 1000)),
          },
        }
      );
    }

    try {
      const result = await analyzeMarket(parsed.data);

      // Persist for the shareable read-only view. Best-effort: a store failure
      // must never turn a successful analysis into an error for the user.
      let reportId: string | undefined;
      try {
        reportId = await saveReport(result);
      } catch (err) {
        logger.warn("analyze-market report save failed", serializeError(err));
      }

      logger.info("analyze-market request completed", {
        durationMs: Date.now() - startedAt,
        status: 200,
        usedMockData: result.dataQuality.usedMockData,
        discoverySource: result.dataQuality.discoverySource,
        reportSaved: reportId !== undefined,
      });
      return NextResponse.json(
        { ...result, reportId },
        { status: 200, headers: { "x-request-id": requestId } }
      );
    } catch (err) {
      logger.error("analyze-market failed", {
        ...serializeError(err),
        durationMs: Date.now() - startedAt,
      });
      return NextResponse.json(
        {
          error:
            "Analysis failed unexpectedly. Please try again, or the app will use fallback demo data.",
        },
        { status: 500, headers: { "x-request-id": requestId } }
      );
    }
  });
}
