import { NextResponse } from "next/server";
import { checkGuardNotExhausted, enforceGuard } from "@/lib/api-guard";
import { logger, serializeError, withRequestId } from "@/lib/logger";
import { isMaintenanceMode, MAINTENANCE_RESPONSE } from "@/lib/maintenance";
import { classifyPipelineError } from "@/lib/pipeline-errors";
import { REQUEST_ID_HEADER, requestIdFrom } from "@/lib/request-id";
import {
  isSampleRefreshConfigured,
  refreshRealSample,
  SAMPLE_REFRESH_HEADER,
  sampleRefreshSecretMatches,
  SampleRefreshQualityError,
} from "@/lib/sample-refresh";
import { getSampleCatalogEntry } from "@/lib/sample-catalog";
import { methodHandlers } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Matches the refresh workflow's spacing between attempts.
const RETRY_AFTER_SECONDS = 65;

function parseRefreshBody(value: unknown): { catalogId: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const keys = Object.keys(body);
  return keys.length === 1 && keys[0] === "catalogId" && typeof body.catalogId === "string"
    ? { catalogId: body.catalogId }
    : null;
}

export async function POST(request: Request) {
  const requestId = requestIdFrom(request);
  return withRequestId(requestId, () => handleRefresh(request, requestId));
}

async function handleRefresh(request: Request, requestId: string): Promise<Response> {
  const baseHeaders = { [REQUEST_ID_HEADER]: requestId };
  // Maintenance contains production: no third-party pipeline runs and no KV
  // writes, same as the other analysis APIs (DEPLOY.md section 1).
  if (isMaintenanceMode()) {
    return NextResponse.json(MAINTENANCE_RESPONSE, {
      status: 503,
      headers: { ...baseHeaders, "Retry-After": "3600" },
    });
  }
  if (!isSampleRefreshConfigured()) {
    return NextResponse.json(
      { code: "SAMPLE_REFRESH_NOT_CONFIGURED", error: "Sample refresh is not configured." },
      { status: 503, headers: baseHeaders }
    );
  }
  const rateLimited = (guard: { retryAfterMs?: number }) => {
    const headers: Record<string, string> = { ...baseHeaders };
    if (guard.retryAfterMs !== undefined) {
      headers["Retry-After"] = String(Math.ceil(guard.retryAfterMs / 1000));
    }
    return NextResponse.json(
      { code: "RATE_LIMITED", error: "Too many failed sample refresh attempts." },
      { status: 429, headers }
    );
  };
  // Only FAILED attempts are counted against the per-IP 'refresh-auth'
  // bucket, so the daily workflow never consumes it. The bucket is checked
  // (read-only) BEFORE the secret is compared: once a client has used up its
  // failed attempts for the window, no further guess is evaluated at all,
  // right or wrong.
  const exhausted = await checkGuardNotExhausted(request, "refresh-auth");
  if (!exhausted.ok) {
    logger.warn("sample refresh rejected: failed-attempt limit reached", {
      retryAfterMs: exhausted.retryAfterMs,
    });
    return rateLimited(exhausted);
  }
  const provided = request.headers.get(SAMPLE_REFRESH_HEADER) ?? "";
  if (!sampleRefreshSecretMatches(provided)) {
    const guard = await enforceGuard(request, { bucket: "refresh-auth" });
    if (!guard.ok && guard.status === 429) return rateLimited(guard);
    return NextResponse.json(
      { code: "UNAUTHORIZED", error: "Invalid sample refresh credentials." },
      { status: 401, headers: baseHeaders }
    );
  }

  let body: { catalogId: string } | null;
  try {
    body = parseRefreshBody(await request.json());
  } catch {
    body = null;
  }
  if (!body) {
    return NextResponse.json(
      { code: "INVALID_REQUEST", error: "Body must be exactly { catalogId }." },
      { status: 400, headers: baseHeaders }
    );
  }
  if (!getSampleCatalogEntry(body.catalogId)) {
    return NextResponse.json(
      { code: "UNKNOWN_CATALOG_ID", error: "Unknown sample catalog id." },
      { status: 400, headers: baseHeaders }
    );
  }

  try {
    const snapshot = await refreshRealSample(body.catalogId);
    logger.info("real sample refreshed", {
      catalogId: snapshot.catalogId,
      sampleId: snapshot.sampleId,
      reportId: snapshot.reportId,
    });
    return NextResponse.json(
      {
        catalogId: snapshot.catalogId,
        sampleId: snapshot.sampleId,
        reportId: snapshot.reportId,
        generatedAt: snapshot.generatedAt,
      },
      { headers: baseHeaders }
    );
  } catch (error) {
    if (error instanceof SampleRefreshQualityError) {
      logger.warn("real sample quality gate failed", {
        catalogId: body.catalogId,
        violations: error.violations,
      });
      return NextResponse.json(
        {
          code: "SAMPLE_QUALITY_GATE_FAILED",
          error: "The refreshed report did not meet the real-sample quality gate.",
          violations: error.violations,
        },
        { status: 422, headers: baseHeaders }
      );
    }

    // Typed outcome so the workflow can retry transient upstream outages
    // (503/504, retryable) and skip deterministic failures (422). Unknown
    // errors stay an opaque 500.
    const failure = classifyPipelineError(error);
    const fields = {
      ...serializeError(error),
      catalogId: body.catalogId,
      code: failure.code,
      status: failure.status,
      retryable: failure.retryable,
    };
    if (failure.status >= 500) logger.error("real sample refresh failed", fields);
    else logger.warn("real sample refresh failed", fields);

    const headers: Record<string, string> = { ...baseHeaders };
    if (failure.retryable) headers["Retry-After"] = String(RETRY_AFTER_SECONDS);
    return NextResponse.json(
      {
        code: failure.code,
        error: failure.message,
        retryable: failure.retryable,
      },
      { status: failure.status, headers }
    );
  }
}

// Unsupported methods get the shared JSON 405 with an accurate Allow header
// instead of Next's bare default (see lib/http.ts).
const { OPTIONS, methodNotAllowed } = methodHandlers("POST, OPTIONS");
export { OPTIONS };
export const GET = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
