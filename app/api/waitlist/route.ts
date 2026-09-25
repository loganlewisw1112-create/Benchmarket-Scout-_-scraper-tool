import { NextResponse } from "next/server";
import { enforceGuard, enforceSameSiteJsonPost } from "@/lib/api-guard";
import { logger, serializeError, withRequestId } from "@/lib/logger";
import { requestIdFrom } from "@/lib/request-id";
import { admitWaitlistEmail } from "@/lib/store";
import { validateWaitlistRequest } from "@/lib/waitlist";
import { methodHandlers } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Every error body follows the shared `{ code, error }` shape.
export async function POST(request: Request) {
  // The proxy's id when present, so logs and the response header match.
  const requestId = requestIdFrom(request);

  return withRequestId(requestId, async () => {
    // Same-site JSON first: a cross-site or text/plain POST is rejected
    // before it can spend the sender's (or anyone's) rate-limit budget.
    const sameSite = enforceSameSiteJsonPost(request);
    if (!sameSite.ok) {
      logger.warn("waitlist rejected by same-site check", {
        status: sameSite.status,
        code: sameSite.code,
      });
      return NextResponse.json(
        { code: sameSite.code, error: sameSite.error },
        { status: sameSite.status, headers: { "x-request-id": requestId } }
      );
    }

    const guard = await enforceGuard(request, { bucket: "waitlist" });
    if (!guard.ok) {
      logger.warn("waitlist rejected by guard", {
        status: guard.status,
        code: guard.code,
        retryAfterMs: guard.retryAfterMs,
      });
      const headers: Record<string, string> = { "x-request-id": requestId };
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
        { status: 400, headers: { "x-request-id": requestId } }
      );
    }

    const parsed = validateWaitlistRequest(body);
    if (!parsed.success) {
      return NextResponse.json(
        {
          code: "INVALID_REQUEST",
          error:
            "Please enter a valid email address and keep feedback under 1,000 characters.",
          details: parsed.error.flatten().fieldErrors,
        },
        { status: 400, headers: { "x-request-id": requestId } }
      );
    }

    try {
      const admission = await admitWaitlistEmail(parsed.data.email, {
        source: parsed.data.source,
        reportId: parsed.data.reportId,
        message: parsed.data.message,
      });
      if (admission.outcome === "rate_limited") {
        return NextResponse.json(
          {
            code: "RATE_LIMITED",
            error:
              "We have received 10 new signups this minute. Please wait a moment and try again.",
          },
          {
            status: 429,
            headers: {
              "x-request-id": requestId,
              "Retry-After": String(
                Math.ceil(admission.retryAfterMs / 1000)
              ),
            },
          }
        );
      }
      const outcome = admission.outcome;
      logger.info("waitlist signup", { outcome });
      const hasFeedback = Boolean(parsed.data.message);
      return NextResponse.json(
        {
          status: outcome,
          message:
            outcome === "added"
              ? hasFeedback
                ? "You are on the list, and your feedback was saved."
                : "You are on the list. We will be in touch."
              : hasFeedback
                ? "You are already on the list, and your feedback was saved."
                : "You are already on the list.",
        },
        { status: 200, headers: { "x-request-id": requestId } }
      );
    } catch (err) {
      logger.error("waitlist signup failed", serializeError(err));
      return NextResponse.json(
        {
          code: "STORAGE_UNAVAILABLE",
          error:
            "Signup storage is temporarily unavailable. Please wait a moment and try again.",
          retryable: true,
        },
        {
          status: 503,
          headers: { "x-request-id": requestId, "Retry-After": "60" },
        }
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
