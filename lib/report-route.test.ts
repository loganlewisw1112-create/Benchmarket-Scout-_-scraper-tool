import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ readReportV2: vi.fn() }));

vi.mock("@/lib/store", () => ({ readReportV2: mocks.readReportV2 }));
vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn() },
  serializeError: (error: unknown) => ({ message: String(error) }),
}));

import { GET } from "@/app/api/reports/[id]/route";

function call(id = "report123") {
  return GET(new Request(`http://localhost/api/reports/${id}`), {
    params: Promise.resolve({ id }),
  });
}

describe("GET /api/reports/[id]", () => {
  beforeEach(() => {
    delete process.env.MAINTENANCE_MODE;
    vi.clearAllMocks();
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
    expect(await response.json()).toMatchObject({ code: "LEGACY_REPORT_UNAVAILABLE" });
  });

  it("returns 404 only for a missing report", async () => {
    mocks.readReportV2.mockResolvedValue({ status: "missing" });
    const response = await call();
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "REPORT_NOT_FOUND" });
  });

  it("returns a retryable 503 when durable storage is unavailable", async () => {
    mocks.readReportV2.mockRejectedValue(new Error("store down"));
    const response = await call();
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(await response.json()).toMatchObject({
      code: "SOURCE_UNAVAILABLE",
      retryable: true,
    });
  });

  it("blocks reads during maintenance", async () => {
    process.env.MAINTENANCE_MODE = "true";
    const response = await call();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "MAINTENANCE" });
    expect(mocks.readReportV2).not.toHaveBeenCalled();
  });
});
