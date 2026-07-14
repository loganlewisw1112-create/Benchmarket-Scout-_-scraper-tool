import { NextResponse } from "next/server";
import { analyzeMarket } from "@/lib/analyze-market";
import { enforceGuard } from "@/lib/api-guard";
import { logger, serializeError, withRequestId } from "@/lib/logger";
import { saveReport } from "@/lib/store";
import { validateAnalyzeMarketRequest } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
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
