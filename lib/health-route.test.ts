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

beforeEach(() => {
  mocks.maintenance = false;
  mocks.health.mockReset();
  delete process.env.VERCEL;
  delete process.env.VERCEL_ENV;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
});

afterEach(() => {
  delete process.env.VERCEL;
  delete process.env.VERCEL_ENV;
});

describe("GET /api/health real sample metrics", () => {
  it("surfaces the sample count, oldest age, and alert state", async () => {
    mocks.health.mockResolvedValue({
      activeSampleCount: 9,
      oldestSampleAgeHours: 12.5,
      alert: true,
      alertReasons: ["ACTIVE_SAMPLE_COUNT_LOW"],
    });
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "degraded",
      activeSampleCount: 9,
      oldestSampleAgeHours: 12.5,
      alert: true,
    });
  });

  it("fails health closed when sample storage is unavailable", async () => {
    mocks.health.mockRejectedValue(new Error("store down"));
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      status: "degraded",
      activeSampleCount: 0,
      alert: true,
      alertReasons: ["SAMPLE_STORE_UNAVAILABLE"],
    });
  });

  it("alerts when a hosted deployment has no durable report store", async () => {
    process.env.VERCEL = "1";
    mocks.health.mockResolvedValue({
      activeSampleCount: 12,
      oldestSampleAgeHours: 2,
      alert: false,
      alertReasons: [],
    });
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      status: "degraded",
      durableStoreConfigured: false,
      activeSampleCount: 0,
      alert: true,
      alertReasons: [
        "DURABLE_STORE_UNAVAILABLE",
        "SAMPLE_STORE_UNAVAILABLE",
      ],
    });
    expect(mocks.health).not.toHaveBeenCalled();
  });

  it("reports a complete hosted REST KV pair as configured", async () => {
    process.env.VERCEL = "1";
    process.env.KV_REST_API_URL = "https://kv.test";
    process.env.KV_REST_API_TOKEN = "token";
    mocks.health.mockResolvedValue({
      activeSampleCount: 12,
      oldestSampleAgeHours: 2,
      alert: false,
      alertReasons: [],
    });
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "ok",
      durableStoreConfigured: true,
      activeSampleCount: 12,
      alert: false,
    });
  });
});
