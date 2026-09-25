import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clientKeyFromHeaders,
  enforceGlobalAnalyzeLimit,
  enforceGuard,
  enforceGuardForKey,
  enforceSameSiteJsonPost,
  GLOBAL_ANALYSES_PER_WINDOW,
  GUARD_BUCKET_LIMITS,
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
    expect(result).toMatchObject({
      ok: false,
      status: 401,
      code: "ACCESS_CODE_REQUIRED",
    });
  });

  it("accepts a correct raw key via the header only (SEC-8)", async () => {
    process.env.SCOUT_API_KEY = "secret";
    expect(
      (await enforceGuard(makeRequest("10.0.0.3", { key: "secret" }))).ok
    ).toBe(true);
    // The ?key= query parameter is no longer accepted.
    expect(
      await enforceGuard(makeRequest("10.0.0.4", { queryKey: "secret" }))
    ).toMatchObject({ ok: false, status: 401, code: "ACCESS_CODE_REQUIRED" });
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

  it("does not gate shared-report reads or refresh auth on the access key", async () => {
    process.env.SCOUT_API_KEY = "secret";
    expect(
      (await enforceGuard(makeRequest("10.2.0.1"), { bucket: "reports" })).ok
    ).toBe(true);
    expect(
      (await enforceGuard(makeRequest("10.2.0.1"), { bucket: "refresh-auth" })).ok
    ).toBe(true);
    for (const bucket of ["analyze", "sample", "waitlist"] as const) {
      expect(
        (await enforceGuard(makeRequest("10.2.0.1"), { bucket })).ok
      ).toBe(false);
    }
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
    expect(blocked).toMatchObject({ ok: false, status: 429, code: "RATE_LIMITED" });
    if (!blocked.ok) expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  it("uses the contract's per-bucket limits", () => {
    expect(GUARD_BUCKET_LIMITS).toEqual({
      analyze: 10,
      sample: 30,
      waitlist: 5,
      reports: 60,
      "refresh-auth": 10,
    });
  });

  it("keeps a separate counter per bucket", async () => {
    const ip = "203.0.113.78";
    for (let i = 0; i < GUARD_BUCKET_LIMITS.waitlist; i++) {
      expect(
        (await enforceGuard(makeRequest(ip), { bucket: "waitlist" })).ok
      ).toBe(true);
    }
    expect(
      await enforceGuard(makeRequest(ip), { bucket: "waitlist" })
    ).toMatchObject({ ok: false, status: 429, code: "RATE_LIMITED" });

    // Exhausting "waitlist" leaves the other buckets untouched.
    expect((await enforceGuard(makeRequest(ip))).ok).toBe(true);
    expect(
      (await enforceGuard(makeRequest(ip), { bucket: "reports" })).ok
    ).toBe(true);
  });

  it("allows 60 report reads per minute before limiting", async () => {
    const ip = "203.0.113.79";
    for (let i = 0; i < GUARD_BUCKET_LIMITS.reports; i++) {
      expect(
        (await enforceGuard(makeRequest(ip), { bucket: "reports" })).ok
      ).toBe(true);
    }
    expect(
      (await enforceGuard(makeRequest(ip), { bucket: "reports" })).ok
    ).toBe(false);
  });

  it("rate-limits server-component callers by client key", async () => {
    const key = clientKeyFromHeaders(
      new Headers({ "x-forwarded-for": "203.0.113.80, 10.0.0.1" })
    );
    expect(key).toBe("203.0.113.80");
    for (let i = 0; i < GUARD_BUCKET_LIMITS.reports; i++) {
      expect((await enforceGuardForKey(key, "reports")).ok).toBe(true);
    }
    expect(await enforceGuardForKey(key, "reports")).toMatchObject({
      ok: false,
      status: 429,
      code: "RATE_LIMITED",
    });
  });
});

describe("clientKeyFromHeaders", () => {
  it("falls back to a shared key and keeps only address characters", () => {
    expect(clientKeyFromHeaders(new Headers())).toBe("local");
    expect(
      clientKeyFromHeaders(new Headers({ "x-forwarded-for": "2001:db8::1" }))
    ).toBe("2001:db8::1");
    expect(
      clientKeyFromHeaders(new Headers({ "x-forwarded-for": "1.2.3.4 */{}" }))
    ).toBe("1.2.3.4");
    expect(
      clientKeyFromHeaders(new Headers({ "x-forwarded-for": "a".repeat(500) }))
    ).toHaveLength(64);
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
      expect(blocked.code).toBe("RATE_LIMITED");
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
      expect(result.code).toBe("RATE_LIMIT_UNAVAILABLE");
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

  it("namespaces per-IP and global KV keys so they cannot collide (SEC-11)", async () => {
    process.env.KV_REST_API_URL = "https://kv.test";
    process.env.KV_REST_API_TOKEN = "token";
    const keys: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const command = JSON.parse(String(init.body)) as unknown[];
        keys.push(
          ...command.filter(
            (part): part is string =>
              typeof part === "string" && part.startsWith("rl:")
          )
        );
        // The capped global script returns [allowed, count]; the per-IP
        // counter returns the new count.
        const result = command.length === 6 ? [1, 1] : 1;
        return new Response(JSON.stringify({ result }));
      })
    );

    // A client key that spells the global key is confined to rl:ip:...
    await enforceGuard(makeRequest("global:analyze-market"), {
      bucket: "reports",
    });
    await enforceGlobalAnalyzeLimit(T0);

    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/^rl:ip:reports:global:analyze-market:\d+$/);
    expect(keys[1]).toMatch(/^rl:global:analyze-market:\d+$/);
  });
});

describe("enforceSameSiteJsonPost (SEC-7)", () => {
  function post(headers: Record<string, string>) {
    return new Request("https://scout.test/api/waitlist", {
      method: "POST",
      headers: { host: "scout.test", ...headers },
      body: "{}",
    });
  }

  it("accepts a same-origin JSON POST, with or without parameters", () => {
    expect(
      enforceSameSiteJsonPost(
        post({ "content-type": "application/json", origin: "https://scout.test" })
      )
    ).toEqual({ ok: true });
    expect(
      enforceSameSiteJsonPost(
        post({
          "content-type": "Application/JSON; charset=utf-8",
          "sec-fetch-site": "same-origin",
        })
      )
    ).toEqual({ ok: true });
  });

  it("accepts a JSON POST with no Origin (non-browser client)", () => {
    expect(
      enforceSameSiteJsonPost(post({ "content-type": "application/json" }))
    ).toEqual({ ok: true });
  });

  it.each([
    "text/plain",
    "application/x-www-form-urlencoded",
    "multipart/form-data; boundary=x",
    "",
  ])("rejects content-type %j with 415", (contentType) => {
    const headers: Record<string, string> = { origin: "https://scout.test" };
    if (contentType) headers["content-type"] = contentType;
    expect(enforceSameSiteJsonPost(post(headers))).toMatchObject({
      ok: false,
      status: 415,
      code: "UNSUPPORTED_MEDIA_TYPE",
    });
  });

  it("rejects Sec-Fetch-Site: cross-site with 403", () => {
    expect(
      enforceSameSiteJsonPost(
        post({ "content-type": "application/json", "sec-fetch-site": "cross-site" })
      )
    ).toMatchObject({ ok: false, status: 403, code: "CROSS_SITE_REQUEST" });
  });

  it.each([
    "https://evil.test",
    "null",
    "https://scout.test.evil.test",
    "http://scout.test:8080",
  ])("rejects Origin %s with 403", (origin) => {
    expect(
      enforceSameSiteJsonPost(post({ "content-type": "application/json", origin }))
    ).toMatchObject({ ok: false, status: 403, code: "CROSS_SITE_REQUEST" });
  });

  it("compares against x-forwarded-host when a proxy sets it", () => {
    expect(
      enforceSameSiteJsonPost(
        post({
          "content-type": "application/json",
          "x-forwarded-host": "public.test",
          origin: "https://public.test",
        })
      )
    ).toEqual({ ok: true });
  });
});
