import { NextResponse } from "next/server";
import { analyzeMarket } from "@/lib/analyze-market";
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
  const rate = checkRateLimit(clientKeyFrom(request));
  if (!rate.allowed) {
    return NextResponse.json(
      {
        error:
          "Too many requests. Each analysis queries several free public services — please wait a minute and try again.",
      },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(rate.resetMs / 1000)) },
      }
    );
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON." },
      { status: 400 }
    );
  }

  const parsed = validateAnalyzeMarketRequest(body);

  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Invalid input.",
        details: parsed.error.flatten().fieldErrors,
      },
      { status: 400 }
    );
  }

  try {
    const result = await analyzeMarket(parsed.data);
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    console.error("analyze-market failed", err);
    return NextResponse.json(
      {
        error:
          "Analysis failed unexpectedly. Please try again, or the app will use fallback demo data.",
      },
      { status: 500 }
    );
  }
}
