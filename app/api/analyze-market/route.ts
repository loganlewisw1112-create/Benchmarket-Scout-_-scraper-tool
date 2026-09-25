import { NextResponse } from "next/server";
import { analyzeMarket, readCachedAnalysis } from "@/lib/analyze-market";
import {
  enforceGlobalAnalyzeLimit,
  enforceGuard,
  enforceSameSiteJsonPost,
} from "@/lib/api-guard";
import { assertRealDataResponse, RealDataInvariantError } from "@/lib/invariants";
import { logger, serializeError, withRequestId } from "@/lib/logger";
import { isMaintenanceMode, MAINTENANCE_RESPONSE } from "@/lib/maintenance";
import {
  AmbiguousMarketError,
  classifyPipelineError,
  UserSiteUnavailableError,
} from "@/lib/pipeline-errors";
import { REQUEST_ID_HEADER, requestIdFrom } from "@/lib/request-id";
import { saveReport } from "@/lib/store";
import type { AnalyzeMarketResponse } from "@/lib/types";
import {
  validateAnalyzeMarketRequest,
  validationErrorDetails,
  validationErrorMessage,
} from "@/lib/validation";
import { methodHandlers } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  const requestId = requestIdFrom(request);
  if (isMaintenanceMode()) {
    return NextResponse.json(MAINTENANCE_RESPONSE, {
      status: 503,
      headers: { "Retry-After": "3600", [REQUEST_ID_HEADER]: requestId },
    });
  }

  const startedAt = Date.now();

  // Everything inside this scope, including the whole lib/ pipeline,
  // automatically carries requestId on its structured log lines.
  return withRequestId(requestId, async () => {
    logger.info("analyze-market request received", { method: request.method });
    const baseHeaders = { [REQUEST_ID_HEADER]: requestId };

    const sameSite = enforceSameSiteJsonPost(request);
    const guard = sameSite.ok
      ? await enforceGuard(request, { bucket: "analyze" })
      : sameSite;
    if (!guard.ok) {
      logger.warn("analyze-market rejected by guard", {
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

    let body: unknown;

    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { code: "INVALID_REQUEST", error: "Request body must be valid JSON." },
        { status: 400, headers: baseHeaders }
      );
    }

    const parsed = validateAnalyzeMarketRequest(body);

    if (!parsed.success) {
      logger.warn("analyze-market rejected invalid input", {
        issues: parsed.error.issues.length,
      });
      return NextResponse.json(
        {
          code: "INVALID_REQUEST",
          error: validationErrorMessage(parsed.error),
          details: validationErrorDetails(parsed.error),
        },
        { status: 400, headers: baseHeaders }
      );
    }

    const respondWith = async (
      result: AnalyzeMarketResponse
    ): Promise<NextResponse> => {
      // The route is the final fail-closed boundary before any v2 payload is
      // persisted or returned. saveReport repeats the same invariant before
      // writing the versioned key.
      assertRealDataResponse(result);
      let reportId: string;
      try {
        reportId = await saveReport(result);
      } catch (err) {
        logger.error("analyze-market report save failed", serializeError(err));
        return NextResponse.json(
          {
            code: "SOURCE_UNAVAILABLE",
            error: "The verified report could not be saved. Please retry.",
            retryable: true,
          },
          { status: 503, headers: { ...baseHeaders, "Retry-After": "60" } }
        );
      }

      logger.info("analyze-market request completed", {
        durationMs: Date.now() - startedAt,
        status: 200,
        cacheHit: result.dataQuality.cacheHit,
        coverageStatus: result.dataQuality.coverageStatus,
        realCompetitorsFound: result.dataQuality.realCompetitorsFound,
        scoredCompetitors: result.dataQuality.scoredCompetitors,
        reportSaved: true,
      });
      return NextResponse.json(
        { ...result, reportId },
        { status: 200, headers: baseHeaders }
      );
    };

    try {
      // A cached analysis (≤6 h, flagged cacheHit, original generatedAt)
      // queries no third-party service, so it does not use a global slot.
      const cached = await readCachedAnalysis(parsed.data);
      if (cached) return await respondWith(cached);

      const globalLimit = await enforceGlobalAnalyzeLimit();
      if (!globalLimit.ok) {
        logger.warn("analyze-market rejected by global limit", {
          retryAfterMs: globalLimit.retryAfterMs,
        });
        return NextResponse.json(
          { code: globalLimit.code, error: globalLimit.error },
          {
            status: globalLimit.status,
            headers: {
              ...baseHeaders,
              "Retry-After": String(Math.ceil(globalLimit.retryAfterMs / 1000)),
            },
          }
        );
      }

      const result = await analyzeMarket(parsed.data, { signal: request.signal });
      return await respondWith(result);
    } catch (err) {
      if (err instanceof RealDataInvariantError) {
        logger.error("analyze-market failed real-data invariant", {
          ...serializeError(err),
          durationMs: Date.now() - startedAt,
        });
        return NextResponse.json(
          {
            code: "REAL_DATA_INVARIANT_FAILED",
            error: "The report failed the real-data provenance safety check.",
          },
          { status: 500, headers: baseHeaders }
        );
      }

      const failure = classifyPipelineError(err);
      const logFields = {
        ...serializeError(err),
        code: failure.code,
        status: failure.status,
        clientAborted: request.signal.aborted,
        durationMs: Date.now() - startedAt,
      };
      // User-caused outcomes (4xx) are warnings; only faults are errors.
      if (failure.status < 500) logger.warn("analyze-market rejected", logFields);
      else logger.error("analyze-market failed", logFields);

      const headers: Record<string, string> = { ...baseHeaders };
      if (failure.retryable) headers["Retry-After"] = "60";
      return NextResponse.json(
        {
          code: failure.code,
          error: failure.message,
          retryable: failure.retryable,
          ...(err instanceof AmbiguousMarketError
            ? { candidates: err.candidates.slice(0, 5) }
            : {}),
          ...(err instanceof UserSiteUnavailableError ? { reason: err.reason } : {}),
        },
        { status: failure.status, headers }
      );
    }
  });
}

// Unsupported methods get the shared JSON 405 with an accurate Allow header
// instead of Next's bare default (see lib/http.ts).
const { OPTIONS, methodNotAllowed } = methodHandlers("POST, OPTIONS");
export { OPTIONS };
export const GET = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
