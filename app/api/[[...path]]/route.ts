import { NextResponse } from "next/server";
import { REQUEST_ID_HEADER, requestIdFrom } from "@/lib/request-id";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// JSON 404 for any /api path with no route of its own, including /api and
// /api/reports without an id. Without this, Next serves the marketing-site
// HTML 404 page, which breaks API clients that always parse JSON. Next
// matches static and dynamic segments before an optional catch-all, so every
// real route (e.g. /api/reports/[id], /api/sample-report/refresh) still wins.
function notFound(request: Request) {
  return NextResponse.json(
    { code: "NOT_FOUND", error: "No API endpoint exists at this path." },
    {
      status: 404,
      headers: {
        [REQUEST_ID_HEADER]: requestIdFrom(request),
        "Cache-Control": "no-store",
      },
    }
  );
}

export const GET = notFound;
export const HEAD = notFound;
export const POST = notFound;
export const PUT = notFound;
export const PATCH = notFound;
export const DELETE = notFound;
export const OPTIONS = notFound;
