import { NextResponse } from "next/server";
import { analyzeMarket } from "@/lib/analyze-market";
import { logger, serializeError, withRequestId } from "@/lib/logger";
import { checkRateLimit } from "@/lib/rate-limit";
import { validateAnalyzeMarketRequest } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function clientKeyFrom(request: Request): string {
  // First hop of x-forwarded-for when behind a proxy; a shared fallback key
  // otherwise (single local instance, so this still bounds total throughput).
  const forwarded = request.headers.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || "local";
}

export async function POST(request: Request) {
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();

  // Everything inside this scope — including the whole lib/ pipeline —
  // automatically carries requestId on its structured log lines.
  return withRequestId(requestId, async () => {
    logger.info("analyze-market request received", { method: request.method });

    const rate = checkRateLimit(clientKeyFrom(request));
    if (!rate.allowed) {
      logger.warn("analyze-market rate limited", { resetMs: rate.resetMs });
      return NextResponse.json(
        {
          error:
            "Too many requests. Each analysis queries several free public services — please wait a minute and try again.",
        },
        {
          status: 429,
          headers: {
            "Retry-After": String(Math.ceil(rate.resetMs / 1000)),
            "x-request-id": requestId,
          },
        }
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
      logger.info("analyze-market request completed", {
        durationMs: Date.now() - startedAt,
        status: 200,
        usedMockData: result.dataQuality.usedMockData,
        discoverySource: result.dataQuality.discoverySource,
      });
      return NextResponse.json(result, {
        status: 200,
        headers: { "x-request-id": requestId },
      });
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
