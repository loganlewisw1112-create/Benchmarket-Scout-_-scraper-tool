import { NextResponse } from "next/server";
import { analyzeMarket } from "@/lib/analyze-market";
import { validateAnalyzeMarketRequest } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
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
