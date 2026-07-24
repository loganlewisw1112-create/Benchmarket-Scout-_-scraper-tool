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
});
