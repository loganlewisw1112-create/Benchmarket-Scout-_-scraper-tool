import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalyzeMarketResponse } from "./types";

vi.mock("./invariants", () => ({
  assertRealDataResponse: (value: AnalyzeMarketResponse) => {
    if (value.schemaVersion !== 2) throw new Error("invalid real-data report");
  },
}));

import {
  CACHE_TTL,
  deleteCache,
  durableCacheKey,
  MAX_DURABLE_CACHE_VALUE_BYTES,
  readCache,
  readCacheEntry,
  writeCache,
} from "./cache";

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-09-20T12:00:00.000Z");

let tmpDir: string;
const prevVercelEnv = process.env.VERCEL_ENV;
const prevAllowPreviewKv = process.env.ALLOW_PREVIEW_KV;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "scout-cache-"));
  process.env.CACHE_DIR = tmpDir;
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete process.env.CACHE_DIR;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  if (prevVercelEnv === undefined) delete process.env.VERCEL_ENV;
  else process.env.VERCEL_ENV = prevVercelEnv;
  if (prevAllowPreviewKv === undefined) delete process.env.ALLOW_PREVIEW_KV;
  else process.env.ALLOW_PREVIEW_KV = prevAllowPreviewKv;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function setClock(at: number): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at);
}

describe("v2 report cache", () => {
  it("validates on write and read and supports forced refresh deletion", async () => {
    const report = { schemaVersion: 2 } as AnalyzeMarketResponse;
    await writeCache("reports", "input", report);
    expect(await readCache("reports", "input")).toEqual(report);
    await deleteCache("reports", "input");
    expect(await readCache("reports", "input")).toBeNull();
  });

  it("does not write a report that violates the invariant", async () => {
    await expect(
      writeCache(
        "reports",
        "bad",
        { schemaVersion: 1 } as unknown as AnalyzeMarketResponse
      )
    ).rejects.toThrow("invalid real-data report");
    await expect(fs.readdir(path.join(tmpDir, "reports"))).rejects.toThrow();
  });

  it("expires cached reports after the 6 hour reports TTL", async () => {
    expect(CACHE_TTL.reports).toBe(6 * 60 * 60 * 1000);
    const report = { schemaVersion: 2 } as AnalyzeMarketResponse;
    const now = Date.now();
    const spy = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      await writeCache("reports", "ttl", report);
      spy.mockReturnValue(now + CACHE_TTL.reports - 1_000);
      expect(await readCache("reports", "ttl", CACHE_TTL.reports)).toEqual(report);
      spy.mockReturnValue(now + CACHE_TTL.reports + 1_000);
      expect(await readCache("reports", "ttl", CACHE_TTL.reports)).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("bucket TTLs (file backend)", () => {
  it("uses the documented per-bucket windows", () => {
    expect(CACHE_TTL).toMatchObject({
      geocode: 30 * DAY,
      reports: 6 * 60 * 60 * 1000,
      robots: DAY,
      overpass: 3 * DAY,
      overpassStaleIfError: 14 * DAY,
    });
  });

  it("returns an entry with its write time until the bucket's retention runs out", async () => {
    setClock(T0);
    await writeCache("geocode", "v3:nominatim:austin", { label: "Austin" });
    await writeCache("robots", "robots:https://a.example", { fetched: false, content: "" });

    vi.setSystemTime(T0 + 29 * DAY);
    expect(await readCacheEntry("geocode", "v3:nominatim:austin")).toEqual({
      data: { label: "Austin" },
      savedAt: T0,
    });
    expect(await readCache("robots", "robots:https://a.example")).toBeNull();

    vi.setSystemTime(T0 + 31 * DAY);
    expect(await readCacheEntry("geocode", "v3:nominatim:austin")).toBeNull();
  });

  it("keeps Overpass entries past the fresh window for stale-if-error, up to 14 days", async () => {
    setClock(T0);
    await writeCache("overpass", "v1:query", { elements: [] });

    vi.setSystemTime(T0 + 5 * DAY);
    // Past the 72 h fresh window: a max-age read misses, the entry is still there.
    expect(await readCache("overpass", "v1:query", CACHE_TTL.overpass)).toBeNull();
    expect(await readCacheEntry("overpass", "v1:query")).toMatchObject({ savedAt: T0 });

    vi.setSystemTime(T0 + 14 * DAY + 1);
    expect(await readCacheEntry("overpass", "v1:query")).toBeNull();
  });

  it("treats a corrupt entry as a miss", async () => {
    await writeCache("geocode", "corrupt", { label: "x" });
    const [file] = await fs.readdir(path.join(tmpDir, "geocode"));
    await fs.writeFile(path.join(tmpDir, "geocode", file), "{not json", "utf8");
    expect(await readCache("geocode", "corrupt")).toBeNull();
  });
});

type KvDouble = {
  store: Map<string, string>;
  commands: unknown[][];
  fail: boolean;
};

/** A minimal Upstash REST double: GET, SET (with EX), DEL. */
function stubKv(): KvDouble {
  process.env.KV_REST_API_URL = "https://kv.test";
  process.env.KV_REST_API_TOKEN = "token";
  const kv: KvDouble = { store: new Map(), commands: [], fail: false };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://kv.test");
      const command = JSON.parse(String(init.body)) as unknown[];
      kv.commands.push(command);
      if (kv.fail) throw new Error("KV unreachable");
      const [name, key, value] = command.map(String);
      let result: unknown = null;
      if (name === "GET") result = kv.store.get(key) ?? null;
      if (name === "SET") {
        kv.store.set(key, value);
        result = "OK";
      }
      if (name === "DEL") result = kv.store.delete(key) ? 1 : 0;
      return new Response(JSON.stringify({ result }), { status: 200 });
    })
  );
  return kv;
}

describe("durable buckets (KV backend)", () => {
  it("writes namespaced keys with each bucket's expiry and reads them back", async () => {
    const kv = stubKv();
    const report = { schemaVersion: 2 } as AnalyzeMarketResponse;
    await writeCache("geocode", "v3:nominatim:austin", { label: "Austin" });
    await writeCache("robots", "robots:https://a.example", { fetched: true, content: "" });
    await writeCache("reports", "input", report);
    await writeCache("overpass", "v1:query", { elements: [] });

    const sets = kv.commands.filter((command) => command[0] === "SET");
    expect(sets.map((command) => [command[1], command[3], command[4]])).toEqual([
      [durableCacheKey("geocode", "v3:nominatim:austin"), "EX", 30 * 24 * 60 * 60],
      [durableCacheKey("robots", "robots:https://a.example"), "EX", 24 * 60 * 60],
      [durableCacheKey("reports", "input"), "EX", 6 * 60 * 60],
      [durableCacheKey("overpass", "v1:query"), "EX", 14 * 24 * 60 * 60],
    ]);
    for (const [, key] of sets) {
      expect(key).toMatch(/^cache:v1:(geocode|robots|reports|overpass):[0-9a-f]{64}$/);
    }

    expect(await readCache("geocode", "v3:nominatim:austin")).toEqual({ label: "Austin" });
    expect(await readCache("reports", "input")).toEqual(report);
    // Nothing touched the per-instance file cache.
    expect(await fs.readdir(tmpDir)).toEqual([]);
  });

  it("namespaces by bucket: one key in two buckets is two entries", () => {
    expect(durableCacheKey("geocode", "same")).not.toBe(durableCacheKey("robots", "same"));
  });

  it("honors max age against the stored write time", async () => {
    stubKv();
    setClock(T0);
    await writeCache("overpass", "v1:query", { elements: [] });
    vi.setSystemTime(T0 + CACHE_TTL.overpass + 1);
    expect(await readCache("overpass", "v1:query", CACHE_TTL.overpass)).toBeNull();
    expect(await readCacheEntry("overpass", "v1:query")).toMatchObject({ savedAt: T0 });
  });

  it("deletes from KV for a forced refresh", async () => {
    const kv = stubKv();
    await writeCache("reports", "input", { schemaVersion: 2 } as AnalyzeMarketResponse);
    await deleteCache("reports", "input");
    expect(kv.commands.at(-1)).toEqual(["DEL", durableCacheKey("reports", "input")]);
    expect(await readCache("reports", "input")).toBeNull();
  });

  it("fails open: an unreachable KV is a miss on read and a no-op on write", async () => {
    const kv = stubKv();
    kv.fail = true;
    await expect(writeCache("geocode", "k", { label: "x" })).resolves.toBeUndefined();
    await expect(readCache("geocode", "k")).resolves.toBeNull();
    expect(kv.commands.map((command) => command[0])).toEqual(["SET", "GET"]);
  });

  it("fails open on a KV HTTP error", async () => {
    process.env.KV_REST_API_URL = "https://kv.test";
    process.env.KV_REST_API_TOKEN = "token";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 500 })));
    await expect(readCache("overpass", "v1:query")).resolves.toBeNull();
    await expect(writeCache("overpass", "v1:query", {})).resolves.toBeUndefined();
  });

  it("drops a stored report that no longer passes the real-data invariant", async () => {
    const kv = stubKv();
    kv.store.set(
      durableCacheKey("reports", "input"),
      JSON.stringify({ savedAt: Date.now(), data: { schemaVersion: 1 } })
    );
    expect(await readCache("reports", "input")).toBeNull();
  });

  it("does not send entries too large for a KV request", async () => {
    const kv = stubKv();
    await writeCache("robots", "big", {
      fetched: true,
      content: "x".repeat(MAX_DURABLE_CACHE_VALUE_BYTES),
    });
    expect(kv.commands).toEqual([]);
  });

  it("keeps homepage audits out of KV (per-instance only)", async () => {
    const kv = stubKv();
    await writeCache("homepages", "v4:homepage:x", { audit: {} });
    expect(await readCache("homepages", "v4:homepage:x")).toEqual({ audit: {} });
    expect(kv.commands).toEqual([]);
    expect(await fs.readdir(path.join(tmpDir, "homepages"))).toHaveLength(1);
  });

  it("uses the file backend on a preview deployment unless preview KV is allowed", async () => {
    const kv = stubKv();
    process.env.VERCEL_ENV = "preview";
    delete process.env.ALLOW_PREVIEW_KV;
    await writeCache("geocode", "k", { label: "x" });
    expect(await readCache("geocode", "k")).toEqual({ label: "x" });
    expect(kv.commands).toEqual([]);

    process.env.ALLOW_PREVIEW_KV = "true";
    await writeCache("geocode", "k2", { label: "y" });
    expect(kv.commands.map((command) => command[0])).toEqual(["SET"]);
  });
});
