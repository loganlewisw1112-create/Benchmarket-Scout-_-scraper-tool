import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  configured: true,
  matches: true,
  refresh: vi.fn(),
  guard: vi.fn(),
  peek: vi.fn(),
  classify: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/sample-refresh", () => ({
  isSampleRefreshConfigured: () => mocks.configured,
  sampleRefreshSecretMatches: () => mocks.matches,
  refreshRealSample: mocks.refresh,
  SAMPLE_REFRESH_HEADER: "x-sample-refresh-secret",
  SampleRefreshQualityError: class SampleRefreshQualityError extends Error {
    violations: string[];
    constructor(violations: string[]) {
      super("quality");
      this.violations = violations;
    }
  },
}));
vi.mock("@/lib/logger", () => ({
  logger: mocks.logger,
  serializeError: vi.fn(() => ({})),
  withRequestId: (_id: string, fn: () => unknown) => fn(),
}));
vi.mock("@/lib/api-guard", () => ({
  enforceGuard: mocks.guard,
  checkGuardNotExhausted: mocks.peek,
}));
vi.mock("@/lib/pipeline-errors", () => ({
  classifyPipelineError: mocks.classify,
}));

import { POST } from "@/app/api/sample-report/refresh/route";
import { SampleRefreshQualityError } from "@/lib/sample-refresh";

function request(body: unknown, secret = "secret"): Request {
  return new Request("http://localhost/api/sample-report/refresh", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-sample-refresh-secret": secret,
    },
    body: JSON.stringify(body),
  });
}

const CATALOG_ID = "bakery-firebrand-bread";

beforeEach(() => {
  mocks.configured = true;
  mocks.matches = true;
  mocks.refresh.mockReset();
  mocks.guard.mockReset();
  mocks.guard.mockResolvedValue({ ok: true });
  mocks.peek.mockReset();
  mocks.peek.mockResolvedValue({ ok: true });
  mocks.classify.mockReset();
  mocks.logger.warn.mockReset();
  mocks.logger.error.mockReset();
  delete process.env.MAINTENANCE_MODE;
});

describe("POST /api/sample-report/refresh", () => {
  it("rejects bad credentials and counts the failure in the refresh-auth bucket", async () => {
    mocks.matches = false;
    const response = await POST(request({ catalogId: CATALOG_ID }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      code: "UNAUTHORIZED",
      error: "Invalid sample refresh credentials.",
    });
    expect(mocks.guard).toHaveBeenCalledTimes(1);
    expect(mocks.guard.mock.calls[0]?.[1]).toEqual({ bucket: "refresh-auth" });
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("returns 429 once failed attempts exhaust the refresh-auth bucket", async () => {
    mocks.matches = false;
    mocks.guard.mockResolvedValue({
      ok: false,
      status: 429,
      code: "RATE_LIMITED",
      error: "Too many requests.",
      retryAfterMs: 30_500,
    });
    const response = await POST(request({ catalogId: CATALOG_ID }));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("31");
    expect(await response.json()).toMatchObject({ code: "RATE_LIMITED" });
  });

  it("refuses an exhausted client before its secret is evaluated", async () => {
    mocks.peek.mockResolvedValue({
      ok: false,
      status: 429,
      code: "RATE_LIMITED",
      error: "Too many requests.",
      retryAfterMs: 12_000,
    });
    // Even the correct secret is not accepted while the bucket is exhausted.
    const response = await POST(request({ catalogId: CATALOG_ID }));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("12");
    expect(mocks.peek.mock.calls[0]?.[1]).toBe("refresh-auth");
    expect(mocks.guard).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("returns an x-request-id on its responses", async () => {
    mocks.matches = false;
    const response = await POST(request({ catalogId: CATALOG_ID }));
    expect(response.headers.get("x-request-id")).toMatch(/^[A-Za-z0-9._:-]{8,}$/);
  });

  it("does not touch the rate-limit bucket for a correct secret", async () => {
    mocks.refresh.mockResolvedValue({
      catalogId: CATALOG_ID,
      sampleId: "sampleabc123",
      reportId: "reportabc123",
      generatedAt: "2026-07-19T12:00:00.000Z",
    });
    const response = await POST(request({ catalogId: CATALOG_ID }));
    expect(response.status).toBe(200);
    expect(mocks.guard).not.toHaveBeenCalled();
    expect(mocks.refresh).toHaveBeenCalledWith(CATALOG_ID);
  });

  it("rejects unknown body keys and unknown catalog ids", async () => {
    const extra = await POST(request({ catalogId: CATALOG_ID, force: true }));
    expect(extra.status).toBe(400);
    const unknown = await POST(request({ catalogId: "not-in-the-catalog" }));
    expect(unknown.status).toBe(400);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("returns 503 MAINTENANCE and runs nothing while maintenance is on", async () => {
    process.env.MAINTENANCE_MODE = "true";
    const response = await POST(request({ catalogId: CATALOG_ID }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "MAINTENANCE" });
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("keeps the quality-gate failure a 422 with its violations", async () => {
    mocks.refresh.mockRejectedValue(
      new SampleRefreshQualityError(["Only 0 real competitors were found; 4 are required."])
    );
    const response = await POST(request({ catalogId: CATALOG_ID }));
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      code: "SAMPLE_QUALITY_GATE_FAILED",
      error: "The refreshed report did not meet the real-sample quality gate.",
      violations: ["Only 0 real competitors were found; 4 are required."],
    });
    expect(mocks.classify).not.toHaveBeenCalled();
  });

  it("maps a retryable upstream outage to 503 with Retry-After", async () => {
    const error = new Error("Competitor discovery is temporarily unavailable.");
    mocks.refresh.mockRejectedValue(error);
    mocks.classify.mockReturnValue({
      status: 503,
      code: "SOURCE_UNAVAILABLE",
      retryable: true,
      message: "A data source is temporarily unavailable.",
    });
    const response = await POST(request({ catalogId: CATALOG_ID }));
    expect(mocks.classify).toHaveBeenCalledWith(error);
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("65");
    expect(await response.json()).toEqual({
      code: "SOURCE_UNAVAILABLE",
      error: "A data source is temporarily unavailable.",
      retryable: true,
    });
    expect(mocks.logger.error).toHaveBeenCalledTimes(1);
  });

  it("maps a permanent pipeline failure to 422 without Retry-After, logged at warn", async () => {
    mocks.refresh.mockRejectedValue(new Error("no data"));
    mocks.classify.mockReturnValue({
      status: 422,
      code: "INSUFFICIENT_REAL_DATA",
      retryable: false,
      message: "Not enough real data.",
    });
    const response = await POST(request({ catalogId: CATALOG_ID }));
    expect(response.status).toBe(422);
    expect(response.headers.get("retry-after")).toBeNull();
    expect(await response.json()).toMatchObject({
      code: "INSUFFICIENT_REAL_DATA",
      retryable: false,
    });
    expect(mocks.logger.warn).toHaveBeenCalledTimes(1);
    expect(mocks.logger.error).not.toHaveBeenCalled();
  });

  it("keeps unknown errors an opaque 500", async () => {
    mocks.refresh.mockRejectedValue(new TypeError("boom"));
    mocks.classify.mockReturnValue({
      status: 500,
      code: "INTERNAL_ERROR",
      retryable: false,
      message: "Unexpected error.",
    });
    const response = await POST(request({ catalogId: CATALOG_ID }));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      code: "INTERNAL_ERROR",
      error: "Unexpected error.",
      retryable: false,
    });
  });
});
