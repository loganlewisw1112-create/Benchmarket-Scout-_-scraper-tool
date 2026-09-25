import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalyzeMarketResponse } from "./types";

const mocks = vi.hoisted(() => ({
  guard: vi.fn(),
  select: vi.fn(),
  maintenance: false,
}));

vi.mock("@/lib/api-guard", () => ({ enforceGuard: mocks.guard }));
vi.mock("@/lib/sample-pool", () => ({
  selectRandomActiveSample: mocks.select,
  sampleFreshness: () => "active",
}));
vi.mock("@/lib/maintenance", () => ({
  isMaintenanceMode: () => mocks.maintenance,
  MAINTENANCE_RESPONSE: { code: "MAINTENANCE", error: "maintenance" },
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  serializeError: vi.fn(() => ({})),
  withRequestId: vi.fn(async (_id: string, operation: () => unknown) => operation()),
}));

import { GET } from "@/app/api/sample-report/route";

beforeEach(() => {
  mocks.guard.mockReset();
  mocks.guard.mockResolvedValue({ ok: true });
  mocks.maintenance = false;
  mocks.select.mockReset();
});

describe("GET /api/sample-report", () => {
  it("returns only the selected active snapshot and honors exclude", async () => {
    const report = { schemaVersion: 2 } as AnalyzeMarketResponse;
    mocks.select.mockResolvedValue({
      sampleId: "sampleabc123",
      reportId: "reportabc123",
      generatedAt: "2026-07-19T12:00:00.000Z",
      report,
    });
    const response = await GET(
      new Request("http://localhost/api/sample-report?exclude=previous123")
    );
    expect(response.status).toBe(200);
    expect(mocks.select).toHaveBeenCalledWith("previous123");
    expect(await response.json()).toEqual({
      sampleId: "sampleabc123",
      reportId: "reportabc123",
      generatedAt: "2026-07-19T12:00:00.000Z",
      freshness: "active",
      report,
    });
  });

  it("returns the typed 503 when no selectable snapshot exists", async () => {
    mocks.select.mockResolvedValue(null);
    const response = await GET(new Request("http://localhost/api/sample-report"));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "REAL_SAMPLE_UNAVAILABLE" });
  });

  it("uses the 'sample' rate-limit bucket and returns the typed guard error", async () => {
    mocks.guard.mockResolvedValue({
      ok: false,
      status: 429,
      code: "RATE_LIMITED",
      error: "Too many requests.",
      retryAfterMs: 1_200,
    });
    const response = await GET(new Request("http://localhost/api/sample-report"));
    expect(mocks.guard.mock.calls[0]?.[1]).toEqual({ bucket: "sample" });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("2");
    expect(await response.json()).toEqual({
      code: "RATE_LIMITED",
      error: "Too many requests.",
    });
    expect(mocks.select).not.toHaveBeenCalled();
  });
});

describe("GET /api/sample-report request id", () => {
  it("adopts the proxy-forwarded x-request-id, including on the maintenance 503", async () => {
    mocks.select.mockResolvedValue(null);
    const forwarded = { headers: { "x-request-id": "proxy-id-1234" } };
    const response = await GET(new Request("http://localhost/api/sample-report", forwarded));
    expect(response.headers.get("x-request-id")).toBe("proxy-id-1234");

    mocks.maintenance = true;
    const maintenance = await GET(new Request("http://localhost/api/sample-report", forwarded));
    expect(maintenance.status).toBe(503);
    expect(maintenance.headers.get("x-request-id")).toBe("proxy-id-1234");
  });
});
