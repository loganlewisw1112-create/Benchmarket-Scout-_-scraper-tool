import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  enforceGlobalAnalyzeLimit,
  enforceGuard,
  GLOBAL_ANALYSES_PER_WINDOW,
} from "./api-guard";
import { MAX_REQUESTS_PER_WINDOW, WINDOW_MS } from "./rate-limit";

function makeRequest(ip: string, opts: { key?: string; queryKey?: string } = {}) {
  const headers = new Headers({ "x-forwarded-for": ip });
  if (opts.key) headers.set("x-scout-key", opts.key);
  const url = opts.queryKey
    ? `https://x.test/api?key=${opts.queryKey}`
    : "https://x.test/api";
  return new Request(url, { method: "POST", headers });
}

const prevKey = process.env.SCOUT_API_KEY;
const prevHash = process.env.SCOUT_API_KEY_HASH;

beforeEach(() => {
  delete process.env.SCOUT_API_KEY;
  delete process.env.SCOUT_API_KEY_HASH;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (prevKey === undefined) delete process.env.SCOUT_API_KEY;
  else process.env.SCOUT_API_KEY = prevKey;
  if (prevHash === undefined) delete process.env.SCOUT_API_KEY_HASH;
  else process.env.SCOUT_API_KEY_HASH = prevHash;
});

describe("enforceGuard key gate", () => {
  it("allows requests when no key is configured", async () => {
    const result = await enforceGuard(makeRequest("10.0.0.1"));
    expect(result.ok).toBe(true);
  });

  it("rejects a missing key when one is configured", async () => {
    process.env.SCOUT_API_KEY = "secret";
    const result = await enforceGuard(makeRequest("10.0.0.2"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it("accepts a correct raw key via header or query", async () => {
    process.env.SCOUT_API_KEY = "secret";
    expect(
      (await enforceGuard(makeRequest("10.0.0.3", { key: "secret" }))).ok
    ).toBe(true);
    expect(
      (await enforceGuard(makeRequest("10.0.0.4", { queryKey: "secret" }))).ok
    ).toBe(true);
  });

  it("accepts a key matching SCOUT_API_KEY_HASH and rejects others", async () => {
    const key = "beta-shared-code";
    process.env.SCOUT_API_KEY_HASH = crypto
      .createHash("sha256")
      .update(key)
      .digest("hex");
    expect((await enforceGuard(makeRequest("10.1.0.1", { key }))).ok).toBe(true);
    const bad = await enforceGuard(makeRequest("10.1.0.2", { key: "nope" }));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.status).toBe(401);
  });

  it("rejects everything when the hash env is malformed", async () => {
    process.env.SCOUT_API_KEY_HASH = "not-a-valid-hash";
    const result = await enforceGuard(makeRequest("10.1.0.3", { key: "x" }));
    expect(result.ok).toBe(false);
  });
});

describe("enforceGuard rate limiting (in-memory fallback)", () => {
  it("blocks once a single client exceeds the window", async () => {
    const ip = "203.0.113.77";
    for (let i = 0; i < MAX_REQUESTS_PER_WINDOW; i++) {
      const r = await enforceGuard(makeRequest(ip));
      expect(r.ok).toBe(true);
    }
    const blocked = await enforceGuard(makeRequest(ip));
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.status).toBe(429);
  });
});

describe("global fixed-window limit", () => {
  const T0 = 1_750_000_020_000;

  it("caps analyses in memory and resets at the next window", async () => {
    for (let i = 0; i < GLOBAL_ANALYSES_PER_WINDOW; i++) {
      expect((await enforceGlobalAnalyzeLimit(T0)).ok).toBe(true);
    }
    const blocked = await enforceGlobalAnalyzeLimit(T0);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.status).toBe(429);
      expect(blocked.error).toContain("30 analyses");
    }
    expect((await enforceGlobalAnalyzeLimit(T0 + WINDOW_MS)).ok).toBe(true);
  });

  it("fails closed when configured KV is unavailable", async () => {
    process.env.KV_REST_API_URL = "https://kv.test";
    process.env.KV_REST_API_TOKEN = "token";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("KV down")));

    const result = await enforceGlobalAnalyzeLimit(T0 + WINDOW_MS * 2);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(503);
      expect(result.retryAfterMs).toBe(WINDOW_MS);
      expect(result.error).toContain("temporarily unavailable");
    }
  });

  it("keeps the per-IP guard's memory fallback when configured KV fails", async () => {
    process.env.KV_REST_API_URL = "https://kv.test";
    process.env.KV_REST_API_TOKEN = "token";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("KV down")));

    expect((await enforceGuard(makeRequest("198.51.100.200"))).ok).toBe(true);
  });
});
