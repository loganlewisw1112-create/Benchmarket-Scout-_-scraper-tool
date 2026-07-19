import { NextResponse } from "next/server";
import { logger, serializeError } from "@/lib/logger";
import {
  isSampleRefreshConfigured,
  refreshRealSample,
  SAMPLE_REFRESH_HEADER,
  sampleRefreshSecretMatches,
  SampleRefreshQualityError,
} from "@/lib/sample-refresh";
import { getSampleCatalogEntry } from "@/lib/sample-catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function parseRefreshBody(value: unknown): { catalogId: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const keys = Object.keys(body);
  return keys.length === 1 && keys[0] === "catalogId" && typeof body.catalogId === "string"
    ? { catalogId: body.catalogId }
    : null;
}

export async function POST(request: Request) {
  if (!isSampleRefreshConfigured()) {
    return NextResponse.json(
      { code: "SAMPLE_REFRESH_NOT_CONFIGURED", error: "Sample refresh is not configured." },
      { status: 503 }
    );
  }
  const provided = request.headers.get(SAMPLE_REFRESH_HEADER) ?? "";
  if (!sampleRefreshSecretMatches(provided)) {
    return NextResponse.json(
      { code: "UNAUTHORIZED", error: "Invalid sample refresh credentials." },
      { status: 401 }
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
      { status: 400 }
    );
  }
  if (!getSampleCatalogEntry(body.catalogId)) {
    return NextResponse.json(
      { code: "UNKNOWN_CATALOG_ID", error: "Unknown sample catalog id." },
      { status: 400 }
    );
  }

  try {
    const snapshot = await refreshRealSample(body.catalogId);
    logger.info("real sample refreshed", {
      catalogId: snapshot.catalogId,
      sampleId: snapshot.sampleId,
      reportId: snapshot.reportId,
    });
    return NextResponse.json({
      catalogId: snapshot.catalogId,
      sampleId: snapshot.sampleId,
      reportId: snapshot.reportId,
      generatedAt: snapshot.generatedAt,
    });
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
        { status: 422 }
      );
    }
    logger.error("real sample refresh failed", {
      catalogId: body.catalogId,
      ...serializeError(error),
    });
    return NextResponse.json(
      { code: "SAMPLE_REFRESH_FAILED", error: "The real sample refresh failed." },
      { status: 500 }
    );
  }
}
