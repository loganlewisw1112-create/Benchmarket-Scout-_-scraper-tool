import { NextResponse } from "next/server";
import { logger, serializeError } from "@/lib/logger";
import { getReport } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const stored = await getReport(id);
    if (!stored) {
      return NextResponse.json(
        { error: "Report not found or expired." },
        { status: 404 }
      );
    }
    return NextResponse.json(stored, { status: 200 });
  } catch (err) {
    logger.error("report fetch failed", serializeError(err));
    return NextResponse.json(
      { error: "Could not load report." },
      { status: 500 }
    );
  }
}
