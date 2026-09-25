import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readReportV2: vi.fn(),
  enforceGuard: vi.fn(),
}));

vi.mock("@/lib/store", () => ({
  readReportV2: mocks.readReportV2,
  isValidReportId: (id: string) => /^[A-Za-z0-9_-]{6,64}$/.test(id),
}));
vi.mock("@/lib/api-guard", () => ({ enforceGuard: mocks.enforceGuard }));
vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  serializeError: (error: unknown) => ({ message: String(error) }),
  withRequestId: (_id: string, callback: () => unknown) => callback(),
}));

import { DELETE, GET, OPTIONS, POST } from "@/app/api/reports/[id]/route";

function call(id = "report123", headers?: HeadersInit) {
  return GET(new Request(`http://localhost/api/reports/${id}`, { headers }), {
    params: Promise.resolve({ id }),
  });
}

describe("GET /api/reports/[id]", () => {
  beforeEach(() => {
    delete process.env.MAINTENANCE_MODE;
    vi.clearAllMocks();
    mocks.enforceGuard.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    delete process.env.MAINTENANCE_MODE;
  });

  it("returns a validated v2 envelope", async () => {
    const value = {
      schemaVersion: 2,
      id: "report123",
      createdAt: "2026-07-19T00:00:00.000Z",
      report: { schemaVersion: 2 },
    };
    mocks.readReportV2.mockResolvedValue({ status: "ok", value });
    const response = await call();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(value);
  });

  it.each(["legacy", "invalid"])("returns 410 for %s storage", async (status) => {
    mocks.readReportV2.mockResolvedValue({ status });
    const response = await call();
    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({
      code: "LEGACY_REPORT_UNAVAILABLE",
      error: expect.any(String),
    });
  });

  it("returns 404 only for a missing report", async () => {
    mocks.readReportV2.mockResolvedValue({ status: "missing" });
    const response = await call();
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      code: "REPORT_NOT_FOUND",
      error: expect.any(String),
    });
  });

  it("returns a retryable 503 when durable storage is unavailable", async () => {
    mocks.readReportV2.mockRejectedValue(new Error("store down"));
    const response = await call();
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(await response.json()).toMatchObject({
      code: "SOURCE_UNAVAILABLE",
      error: expect.any(String),
      retryable: true,
    });
  });

  it("blocks reads during maintenance", async () => {
    process.env.MAINTENANCE_MODE = "true";
    const response = await call();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "MAINTENANCE" });
    expect(response.headers.get("x-request-id")).toBeTruthy();
    expect(mocks.readReportV2).not.toHaveBeenCalled();
    expect(mocks.enforceGuard).not.toHaveBeenCalled();
  });

  it("answers a malformed id 404 before the rate-limit guard, spending no KV", async () => {
    for (const id of ["x", "has space", "a".repeat(65), "../etc"]) {
      const response = await call(id);
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ code: "REPORT_NOT_FOUND" });
    }
    expect(mocks.enforceGuard).not.toHaveBeenCalled();
    expect(mocks.readReportV2).not.toHaveBeenCalled();
  });

  it("rate-limits reads in the 'reports' bucket before touching storage (SEC-4)", async () => {
    mocks.enforceGuard.mockResolvedValue({
      ok: false,
      status: 429,
      code: "RATE_LIMITED",
      error: "Too many report requests.",
      retryAfterMs: 12_300,
    });
    const response = await call();
    expect(mocks.enforceGuard).toHaveBeenCalledWith(expect.any(Request), {
      bucket: "reports",
    });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("13");
    expect(await response.json()).toEqual({
      code: "RATE_LIMITED",
      error: "Too many report requests.",
    });
    expect(mocks.readReportV2).not.toHaveBeenCalled();
  });

  it("puts an x-request-id on every response and reuses the proxy's id", async () => {
    mocks.readReportV2.mockResolvedValue({ status: "missing" });
    const minted = await call();
    expect(minted.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);

    const forwarded = await call("report123", {
      "x-request-id": "proxy-id-1234",
    });
    expect(forwarded.headers.get("x-request-id")).toBe("proxy-id-1234");

    // A malformed id (e.g. a log-injection attempt) is replaced.
    const injected = await call("report123", {
      "x-request-id": "bad id\tinjected",
    });
    expect(injected.headers.get("x-request-id")).not.toContain("injected");
  });
});

describe("other methods on /api/reports/[id] (api-contract-4)", () => {
  it("answers 405 with an Allow header and a JSON body", async () => {
    for (const handler of [POST, DELETE]) {
      const response = handler(
        new Request("http://localhost/api/reports/report123", { method: "POST" })
      );
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
      expect(response.headers.get("x-request-id")).toBeTruthy();
      expect(await response.json()).toMatchObject({
        code: "METHOD_NOT_ALLOWED",
        error: expect.any(String),
      });
    }
  });

  it("advertises only the real methods on OPTIONS", () => {
    const response = OPTIONS(
      new Request("http://localhost/api/reports/report123", { method: "OPTIONS" })
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
  });
});
