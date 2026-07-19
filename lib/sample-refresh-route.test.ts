import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  configured: true,
  matches: true,
  refresh: vi.fn(),
}));

vi.mock("@/lib/sample-refresh", () => ({
  isSampleRefreshConfigured: () => mocks.configured,
  sampleRefreshSecretMatches: () => mocks.matches,
  refreshRealSample: mocks.refresh,
  SAMPLE_REFRESH_HEADER: "x-sample-refresh-secret",
  SampleRefreshQualityError: class SampleRefreshQualityError extends Error {
    violations: string[] = [];
  },
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  serializeError: vi.fn(() => ({})),
}));

import { POST } from "@/app/api/sample-report/refresh/route";

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

beforeEach(() => {
  mocks.configured = true;
  mocks.matches = true;
  mocks.refresh.mockReset();
  delete process.env.MAINTENANCE_MODE;
});

describe("POST /api/sample-report/refresh", () => {
  it("rejects bad credentials before accepting a refresh", async () => {
    mocks.matches = false;
    const response = await POST(request({ catalogId: "bakery-firebrand-bread" }));
    expect(response.status).toBe(401);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("rejects unknown body keys and unknown catalog ids", async () => {
    const extra = await POST(
      request({ catalogId: "bakery-firebrand-bread", force: true })
    );
    expect(extra.status).toBe(400);
    const unknown = await POST(request({ catalogId: "not-in-the-catalog" }));
    expect(unknown.status).toBe(400);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("runs one protected catalog refresh", async () => {
    process.env.MAINTENANCE_MODE = "true";
    mocks.refresh.mockResolvedValue({
      catalogId: "bakery-firebrand-bread",
      sampleId: "sampleabc123",
      reportId: "reportabc123",
      generatedAt: "2026-07-19T12:00:00.000Z",
    });
    const response = await POST(request({ catalogId: "bakery-firebrand-bread" }));
    expect(response.status).toBe(200);
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(mocks.refresh).toHaveBeenCalledWith("bakery-firebrand-bread");
  });
});
