import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  health: vi.fn(),
  maintenance: false,
}));

vi.mock("@/lib/sample-pool", () => ({ getSamplePoolHealth: mocks.health }));
vi.mock("@/lib/maintenance", () => ({
  isMaintenanceMode: () => mocks.maintenance,
}));

import { GET } from "@/app/api/health/route";

const OK_CACHE = "public, s-maxage=30, stale-while-revalidate=30";

function pool(overrides: Record<string, unknown> = {}) {
  return {
    activeSampleCount: 12,
    servedSampleCount: 12,
    servingRetained: false,
    oldestSampleAgeHours: 20,
    newestSampleAgeHours: 2,
    alert: false,
    alertReasons: [],
    catalog: { size: 25, withoutFreshSnapshot: 10, withoutFreshSnapshotIds: [] },
    ...overrides,
  };
}

beforeEach(() => {
  mocks.maintenance = false;
  mocks.health.mockReset();
  delete process.env.VERCEL;
  delete process.env.VERCEL_ENV;
  delete process.env.ALLOW_PREVIEW_KV;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
});

afterEach(() => {
  delete process.env.VERCEL;
  delete process.env.VERCEL_ENV;
});

describe("GET /api/health", () => {
  it("returns 200 ok with a shared-cache header when the served pool is healthy", async () => {
    mocks.health.mockResolvedValue(pool());
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(OK_CACHE);
    const body = await response.json();
    expect(body).toMatchObject({
      status: "ok",
      maintenance: false,
      activeSampleCount: 12,
      oldestSampleAgeHours: 20,
      alert: false,
      alertReasons: [],
    });
    // Catalog coverage is informational and never alerts.
    expect(body.catalog).toMatchObject({ size: 25, withoutFreshSnapshot: 10 });
  });

  it("returns 503 no-store with the pool's alert reasons", async () => {
    mocks.health.mockResolvedValue(
      pool({
        activeSampleCount: 9,
        alert: true,
        alertReasons: ["ACTIVE_SAMPLES_LOW"],
      })
    );
    const response = await GET();
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      status: "degraded",
      activeSampleCount: 9,
      alert: true,
      alertReasons: ["ACTIVE_SAMPLES_LOW"],
    });
  });

  it("fails closed with DURABLE_STORE_UNAVAILABLE when the store read throws", async () => {
    mocks.health.mockRejectedValue(new Error("store down"));
    const response = await GET();
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      status: "degraded",
      activeSampleCount: 0,
      alert: true,
      alertReasons: ["DURABLE_STORE_UNAVAILABLE"],
    });
  });

  it("alerts when a hosted deployment has no durable report store", async () => {
    process.env.VERCEL = "1";
    mocks.health.mockResolvedValue(pool());
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      status: "degraded",
      durableStoreConfigured: false,
      activeSampleCount: 0,
      alert: true,
      alertReasons: ["DURABLE_STORE_UNAVAILABLE"],
    });
    expect(mocks.health).not.toHaveBeenCalled();
  });

  it("reports a complete hosted REST KV pair as configured", async () => {
    process.env.VERCEL = "1";
    process.env.KV_REST_API_URL = "https://kv.test";
    process.env.KV_REST_API_TOKEN = "token";
    mocks.health.mockResolvedValue(pool());
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "ok",
      durableStoreConfigured: true,
      activeSampleCount: 12,
      alert: false,
    });
  });

  it("answers 200 with maintenance:true during maintenance, still reporting alerts", async () => {
    mocks.maintenance = true;
    process.env.VERCEL = "1";
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "maintenance",
      maintenance: true,
      alert: true,
      alertReasons: ["DURABLE_STORE_UNAVAILABLE"],
    });
  });

  it("does not report a preview with KV deliberately blocked as a store outage", async () => {
    process.env.VERCEL_ENV = "preview";
    process.env.KV_REST_API_URL = "https://kv.test";
    process.env.KV_REST_API_TOKEN = "token";
    mocks.health.mockResolvedValue(pool());
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "ok",
      durableStoreConfigured: false,
      previewKvBlocked: true,
    });
  });
});
