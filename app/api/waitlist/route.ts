import { NextResponse } from "next/server";
import { enforceGuard } from "@/lib/api-guard";
import { logger, serializeError, withRequestId } from "@/lib/logger";
import { addWaitlistEmail } from "@/lib/store";
import { validateWaitlistRequest } from "@/lib/waitlist";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const requestId = crypto.randomUUID();

  return withRequestId(requestId, async () => {
    const guard = await enforceGuard(request);
    if (!guard.ok) {
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

    const parsed = validateWaitlistRequest(body);
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: "Please enter a valid email address.",
          details: parsed.error.flatten().fieldErrors,
        },
        { status: 400, headers: { "x-request-id": requestId } }
      );
    }

    try {
      const outcome = await addWaitlistEmail(parsed.data.email, {
        source: parsed.data.source,
        reportId: parsed.data.reportId,
      });
      logger.info("waitlist signup", { outcome });
      return NextResponse.json(
        {
          status: outcome,
          message:
            outcome === "added"
              ? "You are on the list. We will be in touch."
              : "You are already on the list.",
        },
        { status: 200, headers: { "x-request-id": requestId } }
      );
    } catch (err) {
      logger.error("waitlist signup failed", serializeError(err));
      return NextResponse.json(
        { error: "Could not save your email. Please try again." },
        { status: 500, headers: { "x-request-id": requestId } }
      );
    }
  });
}
