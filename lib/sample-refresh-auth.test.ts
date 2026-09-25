import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// End-to-end through the real api-guard and in-memory limiter (no KV): the
// failed-attempt bucket must stop secret guessing, not just change the status
// code a wrong guess gets.
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  serializeError: vi.fn(() => ({})),
  withRequestId: (_id: string, fn: () => unknown) => fn(),
}));

const SECRET = "correct-horse-battery-staple-0123456789";
const saved = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  process.env.SAMPLE_REFRESH_SECRET = SECRET;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.MAINTENANCE_MODE;
});

afterEach(() => {
  process.env = { ...saved };
});

function attempt(secret: string, ip: string): Request {
  return new Request("http://localhost/api/sample-report/refresh", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-sample-refresh-secret": secret,
      "x-forwarded-for": ip,
    },
    body: "not json",
  });
}

describe("sample refresh secret guessing", () => {
  it("stops evaluating secrets once an IP exhausts its failed attempts", async () => {
    const { POST } = await import("@/app/api/sample-report/refresh/route");
    const { GUARD_BUCKET_LIMITS } = await import("@/lib/api-guard");
    const limit = GUARD_BUCKET_LIMITS["refresh-auth"];
    const statuses: number[] = [];
    for (let i = 0; i < limit + 3; i++) {
      statuses.push((await POST(attempt(`wrong-${i}`, "203.0.113.9"))).status);
    }
    expect(statuses.slice(0, limit).every((status) => status === 401)).toBe(true);
    expect(statuses.slice(limit).every((status) => status === 429)).toBe(true);

    // The correct secret from the exhausted IP is refused, not evaluated.
    const correct = await POST(attempt(SECRET, "203.0.113.9"));
    expect(correct.status).toBe(429);

    // Another IP is unaffected, and a correct secret never counts.
    const other = await POST(attempt(SECRET, "198.51.100.7"));
    expect(other.status).toBe(400);
  });
});
