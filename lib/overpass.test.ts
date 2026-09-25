import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./time-budget", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./time-budget")>();
  return {
    ...actual,
    abortableDelay: vi.fn(async () => undefined),
  };
});
// The real cache (file backend in a per-test temp dir), wrapped so a test can
// make it fail or take it out of the timing picture.
vi.mock("./cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./cache")>();
  return {
    ...actual,
    readCacheEntry: vi.fn(actual.readCacheEntry),
    writeCache: vi.fn(actual.writeCache),
  };
});

import { CACHE_TTL, durableCacheKey, readCacheEntry, writeCache } from "./cache";
import {
  OSM_CATEGORY_MAP,
  OVERPASS_ENDPOINTS,
  OVERPASS_FAILOVER,
  OVERPASS_OUTPUT_LIMIT,
  overpassCacheKey,
  overpassTurboUrl,
  queryOverpass,
  queryOverpassDetailed,
  resolveIndustry,
  resolveOsmTags,
  type OsmTagPair,
} from "./overpass";
import { SourceUnavailableError } from "./pipeline-errors";

const actualCache = await vi.importActual<typeof import("./cache")>("./cache");
const [PRIMARY, SECONDARY, MAIL_RU] = OVERPASS_ENDPOINTS;
const HOUR = 60 * 60 * 1000;

function response(body: string, ok = true, status = 200) {
  return { ok, status, text: async () => body } as Response;
}

function elementsBody(elements: unknown[]): string {
  return JSON.stringify({ elements });
}

/** A request that never answers until its signal aborts. */
function hang(init: RequestInit): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
  });
}

function sentQuery(fetchMock: ReturnType<typeof vi.fn>, call = 0): string {
  const body = fetchMock.mock.calls[call][1].body as string;
  return decodeURIComponent(body.replace(/^data=/, ""));
}

let cacheDir: string;

beforeEach(async () => {
  cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "scout-overpass-"));
  process.env.CACHE_DIR = cacheDir;
  vi.clearAllMocks();
  vi.mocked(readCacheEntry).mockImplementation(actualCache.readCacheEntry);
  vi.mocked(writeCache).mockImplementation(actualCache.writeCache);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete process.env.CACHE_DIR;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  await fs.rm(cacheDir, { recursive: true, force: true });
});

describe("queryOverpass", () => {
  it("returns elements from the first endpoint on success", async () => {
    const elements = [{ type: "node", id: 1, lat: 30, lon: -97, tags: { name: "Test" } }];
    const fetchMock = vi.fn().mockResolvedValue(response(elementsBody(elements)));
    vi.stubGlobal("fetch", fetchMock);

    const result = await queryOverpassDetailed("dentist", 30, -97);

    expect(result.elements).toEqual(elements);
    expect(result.endpoint).toBe("https://overpass-api.de/api/interpreter");
    expect(result.cache).toBeUndefined();
    expect(Number.isNaN(Date.parse(result.accessedAt))).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://overpass-api.de/api/interpreter");
  });

  it("uses three instances, maps.mail.ru last", () => {
    expect(OVERPASS_ENDPOINTS).toEqual([
      "https://overpass-api.de/api/interpreter",
      "https://overpass.private.coffee/api/interpreter",
      "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    ]);
  });

  it("fails over to the next untried instance after a failure", async () => {
    const elements = [{ type: "node", id: 2, tags: { name: "Second" } }];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response("", false, 504))
      .mockResolvedValue(response(elementsBody(elements)));
    vi.stubGlobal("fetch", fetchMock);

    const result = await queryOverpassDetailed("dentist", 30, -97);

    expect(result.elements).toEqual(elements);
    expect(result.endpoint).toBe(SECONDARY);
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([PRIMARY, SECONDARY]);
  });

  it("reaches maps.mail.ru when the first two instances fail", async () => {
    const elements = [{ type: "node", id: 3, tags: { name: "Third" } }];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response("", false, 504))
      .mockResolvedValueOnce(response("", false, 504))
      .mockResolvedValue(response(elementsBody(elements)));
    vi.stubGlobal("fetch", fetchMock);

    const result = await queryOverpassDetailed("dentist", 30, -97);

    expect(result.elements).toEqual(elements);
    expect(result.endpoint).toBe(MAIL_RU);
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      PRIMARY,
      SECONDARY,
      MAIL_RU,
    ]);
  });

  it("throws after exhausting all attempts, trying every instance before any retry", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response("", false, 500));
    vi.stubGlobal("fetch", fetchMock);

    await expect(queryOverpass("dentist", 30, -97)).rejects.toMatchObject({
      code: "SOURCE_UNAVAILABLE",
      status: 503,
      source: "overpass",
    } satisfies Partial<SourceUnavailableError>);
    // 4 attempts: each instance once, then the one that failed longest ago.
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      PRIMARY,
      SECONDARY,
      MAIL_RU,
      PRIMARY,
    ]);
  });

  it("treats a non-JSON response as a failure and retries", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response("not json"))
      .mockResolvedValue(response(elementsBody([])));
    vi.stubGlobal("fetch", fetchMock);

    const result = await queryOverpass("dentist", 30, -97);
    expect(result).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("includes one clause per resolved tag pair and a 25 s server timeout", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(elementsBody([])));
    vi.stubGlobal("fetch", fetchMock);

    await queryOverpass("dentist", 41.88, -87.63);

    const query = sentQuery(fetchMock);
    expect(OVERPASS_FAILOVER.serverTimeoutSeconds).toBe(25);
    expect(query.startsWith("[out:json][timeout:25];")).toBe(true);
    expect(query).toContain(
      `nwr["amenity"="dentist"]["name"](around:8000,41.88,-87.63);`
    );
    expect(query).toContain(
      `nwr["healthcare"="dentist"]["name"](around:8000,41.88,-87.63);`
    );
    expect(query).toContain("out center tags 500;");
  });

  it("honest floor: never fires a network request when nothing resolves", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    // "the company" is entirely generic stopwords -> honest floor (no tags).
    const result = await queryOverpass("the company llc", 41.88, -87.63);

    expect(result).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readCacheEntry).not.toHaveBeenCalled();
  });

  it("distinguishes a successful zero-result response from transport failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(elementsBody([]))));
    await expect(queryOverpass("dentist", 30, -97)).resolves.toEqual([]);
  });

  it("retries a malformed HTTP-200 payload instead of treating it as zero results", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(JSON.stringify({ remark: "runtime error" })))
      .mockResolvedValue(response(elementsBody([])));
    vi.stubGlobal("fetch", fetchMock);

    await expect(queryOverpass("dentist", 30, -97)).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("raises SOURCE_UNAVAILABLE after malformed payload retries are exhausted", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(response(JSON.stringify({ remark: "runtime error" })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(queryOverpass("dentist", 30, -97)).rejects.toMatchObject({
      code: "SOURCE_UNAVAILABLE",
      status: 503,
      source: "overpass",
    });
    expect(fetchMock).toHaveBeenCalledTimes(OVERPASS_FAILOVER.maxAttempts);
  });

  it("retries an HTTP-200 runtime-error remark even when elements are present", async () => {
    const partial = [{ type: "node", id: 9, tags: { name: "Partial" } }];
    const complete = [...partial, { type: "node", id: 10, tags: { name: "Full" } }];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response(
          JSON.stringify({
            elements: partial,
            remark: 'runtime error: Query timed out in "query" at line 3 after 10 seconds.',
          })
        )
      )
      .mockResolvedValue(response(elementsBody(complete)));
    vi.stubGlobal("fetch", fetchMock);

    const result = await queryOverpassDetailed("dentist", 30, -97);
    expect(result.elements).toEqual(complete);
    expect(result.endpoint).toBe(SECONDARY);
  });

  it("flags a response that reaches the element cap as truncated", async () => {
    const elements = Array.from({ length: OVERPASS_OUTPUT_LIMIT }, (_, id) => ({
      type: "node",
      id,
      tags: { name: `Place ${id}` },
    }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(elementsBody(elements))));
    const result = await queryOverpassDetailed("dentist", 30, -97);
    expect(result.truncated).toBe(true);
    expect(result.query).toContain('nwr["amenity"="dentist"]');
  });

  it("honors an already-canceled parent budget with typed SOURCE_UNAVAILABLE", async () => {
    const controller = new AbortController();
    controller.abort(new Error("request deadline"));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      queryOverpass("dentist", 30, -97, 12_000, {
        signal: controller.signal,
        budgetMs: 6_000,
      })
    ).rejects.toMatchObject({
      code: "SOURCE_UNAVAILABLE",
      status: 503,
      source: "overpass",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("caps the number of tag clauses for a very broad probe", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(elementsBody([])));
    vi.stubGlobal("fetch", fetchMock);

    // A long unmatched phrase probes many keys; the query stays capped.
    await queryOverpass("alpha bravo charlie delta echo foxtrot", 41.88, -87.63);

    const clauseCount = (sentQuery(fetchMock).match(/nwr\[/g) ?? []).length;
    expect(clauseCount).toBeLessThanOrEqual(24);
    expect(clauseCount).toBeGreaterThan(0);
  });
});

describe("queryOverpass hedging and mirror rotation (fake timers)", () => {
  type Call = { url: string; at: number; abortedAt?: number };

  // Timing is exact under fake timers only when the cache answers in
  // microtasks, so these tests take the file cache out of the picture.
  function startClock(): { calls: Call[]; record: (url: string, init: RequestInit) => void } {
    vi.useFakeTimers();
    vi.mocked(readCacheEntry).mockResolvedValue(null);
    vi.mocked(writeCache).mockResolvedValue(undefined);
    const startedAt = Date.now();
    const calls: Call[] = [];
    return {
      calls,
      record: (url, init) => {
        const call: Call = { url, at: Date.now() - startedAt };
        init.signal?.addEventListener("abort", () => {
          call.abortedAt = Date.now() - startedAt;
        });
        calls.push(call);
      },
    };
  }

  it("hedges to each untried instance one hedge delay apart and aborts the losers", async () => {
    const { calls, record } = startClock();
    const elements = [{ type: "node", id: 3, tags: { name: "Hedged" } }];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init: RequestInit) => {
        record(url, init);
        if (url !== MAIL_RU) return hang(init);
        // The slow last resort answers 3 s after it is asked.
        return new Promise<Response>((resolve) =>
          setTimeout(() => resolve(response(elementsBody(elements))), 3_000)
        );
      })
    );

    const pending = queryOverpassDetailed("dentist", 30, -97, 5_000, {
      budgetMs: 24_000,
    });
    await vi.advanceTimersByTimeAsync(20_000);
    const result = await pending;

    expect(OVERPASS_FAILOVER.hedgeDelayMs).toBe(7_000);
    expect(OVERPASS_FAILOVER.maxParallelAttempts).toBe(3);
    expect(calls.map(({ url, at }) => [url, at])).toEqual([
      [PRIMARY, 0],
      [SECONDARY, 7_000],
      [MAIL_RU, 14_000],
    ]);
    expect(result.endpoint).toBe(MAIL_RU);
    expect(result.elements).toEqual(elements);
    // The two hung attempts were aborted as soon as the mirror answered.
    expect(calls[0].abortedAt).toBe(17_000);
    expect(calls[1].abortedAt).toBe(17_000);
  });

  it("replaces a failed attempt at once with an untried instance, not the busy one", async () => {
    const { calls, record } = startClock();
    const elements = [{ type: "node", id: 4, tags: { name: "Replacement" } }];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init: RequestInit) => {
        record(url, init);
        if (url === PRIMARY) return hang(init);
        if (url === SECONDARY) {
          return new Promise<Response>((resolve) =>
            setTimeout(() => resolve(response("", false, 504)), 1_000)
          );
        }
        return Promise.resolve(response(elementsBody(elements)));
      })
    );

    const pending = queryOverpassDetailed("dentist", 30, -97);
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await pending;

    // The mirror started at 7 s failed at 8 s; the next untried instance
    // started right then, not at the 14 s hedge.
    expect(calls.map(({ url, at }) => [url, at])).toEqual([
      [PRIMARY, 0],
      [SECONDARY, 7_000],
      [MAIL_RU, 8_000],
    ]);
    expect(result.endpoint).toBe(MAIL_RU);
  });

  it("retries a failed instance only once all are tried, and never one still in flight", async () => {
    const { calls, record } = startClock();
    const elements = [{ type: "node", id: 5, tags: { name: "Retried" } }];
    let secondaryCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init: RequestInit) => {
        record(url, init);
        if (url === PRIMARY) return hang(init);
        if (url === SECONDARY && ++secondaryCalls === 2) {
          return Promise.resolve(response(elementsBody(elements)));
        }
        return Promise.resolve(response("", false, 504));
      })
    );

    const pending = queryOverpassDetailed("dentist", 30, -97);
    await vi.advanceTimersByTimeAsync(12_000);
    const result = await pending;

    // The hung primary is never duplicated; the retry waits out the pause.
    expect(calls.map(({ url, at }) => [url, at])).toEqual([
      [PRIMARY, 0],
      [SECONDARY, 7_000],
      [MAIL_RU, 7_000],
      [SECONDARY, 7_000 + OVERPASS_FAILOVER.sameEndpointRetryDelayMs],
    ]);
    expect(result.endpoint).toBe(SECONDARY);
    expect(calls[0].abortedAt).toBe(7_000 + OVERPASS_FAILOVER.sameEndpointRetryDelayMs);
  });

  it("gives up with SOURCE_UNAVAILABLE at the stage budget when every instance hangs", async () => {
    const { calls, record } = startClock();
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init: RequestInit) => {
        record(url, init);
        return hang(init);
      })
    );

    const pending = queryOverpassDetailed("dentist", 30, -97, 8_000, {
      budgetMs: 24_000,
    });
    const settled = pending.then(
      () => null,
      (error: unknown) => error
    );
    await vi.advanceTimersByTimeAsync(30_000);

    expect(await settled).toMatchObject({ code: "SOURCE_UNAVAILABLE", status: 503 });
    expect(OVERPASS_FAILOVER.maxAttemptTimeoutMs).toBe(21_000);
    // The first attempt got the full client timeout; the hedges were cut to
    // the stage deadline, and nothing was started too late to finish.
    expect(calls).toEqual([
      { url: PRIMARY, at: 0, abortedAt: 21_000 },
      { url: SECONDARY, at: 7_000, abortedAt: 24_000 },
      { url: MAIL_RU, at: 14_000, abortedAt: 24_000 },
    ]);
  });
});

describe("queryOverpass discovery cache", () => {
  const T0 = Date.parse("2026-09-20T12:00:00.000Z");
  const elements = [
    { type: "node", id: 11, lat: 30.01, lon: -97.01, tags: { name: "Cached Dental", amenity: "dentist" } },
  ];

  function setClock(at: number): void {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at);
  }

  async function primeCache(): Promise<void> {
    setClock(T0);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(elementsBody(elements))));
    const live = await queryOverpassDetailed("dentist", 30, -97);
    expect(live.cache).toBeUndefined();
    expect(live.accessedAt).toBe(new Date(T0).toISOString());
  }

  it("serves a fresh hit (<72 h) without a live query, keeping the original accessedAt", async () => {
    await primeCache();
    vi.setSystemTime(T0 + CACHE_TTL.overpass - HOUR);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const cached = await queryOverpassDetailed("dentist", 30, -97);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(cached).toMatchObject({
      cache: "fresh",
      queryPerformed: true,
      endpoint: PRIMARY,
      accessedAt: new Date(T0).toISOString(),
      truncated: false,
    });
    expect(cached.elements).toEqual(elements);
    expect(cached.query).toContain("[timeout:25]");
  });

  it("queries live once the entry is older than 72 h, and caches the new answer", async () => {
    await primeCache();
    const later = T0 + CACHE_TTL.overpass + HOUR;
    vi.setSystemTime(later);
    const newer = [{ ...elements[0], tags: { ...elements[0].tags, name: "Renamed Dental" } }];
    const fetchMock = vi.fn().mockResolvedValue(response(elementsBody(newer)));
    vi.stubGlobal("fetch", fetchMock);

    const live = await queryOverpassDetailed("dentist", 30, -97);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(live.cache).toBeUndefined();
    expect(live.accessedAt).toBe(new Date(later).toISOString());
    expect(live.elements).toEqual(newer);

    const again = await queryOverpassDetailed("dentist", 30, -97);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(again).toMatchObject({ cache: "fresh", accessedAt: new Date(later).toISOString() });
  });

  it("falls back to a stale entry (<14 days) only when every live attempt fails", async () => {
    await primeCache();
    vi.setSystemTime(T0 + 5 * 24 * HOUR);
    const fetchMock = vi.fn().mockResolvedValue(response("", false, 504));
    vi.stubGlobal("fetch", fetchMock);

    const stale = await queryOverpassDetailed("dentist", 30, -97);

    expect(fetchMock).toHaveBeenCalledTimes(OVERPASS_FAILOVER.maxAttempts);
    expect(stale).toMatchObject({
      cache: "stale",
      queryPerformed: true,
      endpoint: PRIMARY,
      accessedAt: new Date(T0).toISOString(),
    });
    expect(stale.elements).toEqual(elements);
  });

  it("never re-saves a stale entry, and throws once it is older than 14 days", async () => {
    await primeCache();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response("", false, 504)));

    vi.setSystemTime(T0 + CACHE_TTL.overpassStaleIfError - HOUR);
    await expect(queryOverpassDetailed("dentist", 30, -97)).resolves.toMatchObject({
      cache: "stale",
      accessedAt: new Date(T0).toISOString(),
    });

    vi.setSystemTime(T0 + CACHE_TTL.overpassStaleIfError + HOUR);
    await expect(queryOverpassDetailed("dentist", 30, -97)).rejects.toMatchObject({
      code: "SOURCE_UNAVAILABLE",
      status: 503,
      source: "overpass",
    });
    expect(writeCache).toHaveBeenCalledTimes(1);
  });

  it("keys entries by the exact query text: radius, center and tags never collide", async () => {
    await primeCache();
    const fetchMock = vi.fn().mockResolvedValue(response(elementsBody([])));
    vi.stubGlobal("fetch", fetchMock);

    await queryOverpassDetailed("dentist", 30, -97, 4_000); // radius
    await queryOverpassDetailed("dentist", 30.5, -97); // center
    await queryOverpassDetailed("bakery", 30, -97); // tags
    expect(fetchMock).toHaveBeenCalledTimes(3);

    await queryOverpassDetailed("dentist", 30, -97);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("stores only named, located elements with their tags, plus the truncation flag", async () => {
    setClock(T0);
    const full = Array.from({ length: OVERPASS_OUTPUT_LIMIT }, (_, id) => ({
      type: "way",
      id,
      center: { lat: 30, lon: -97 },
      nodes: [1, 2, 3],
      tags: { name: `Place ${id}`, amenity: "dentist", description: "kept: feeds category matching" },
    }));
    full.push({ type: "node", id: 9_999, tags: { name: "Nowhere" } } as never);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(elementsBody(full))));

    const live = await queryOverpassDetailed("dentist", 30, -97);
    expect(live.truncated).toBe(true);

    const entry = await actualCache.readCacheEntry<{
      query: string;
      truncated: boolean;
      elements: Array<Record<string, unknown>>;
    }>("overpass", overpassCacheKey(live.query!));
    expect(entry?.data.query).toBe(live.query);
    expect(entry?.data.truncated).toBe(true);
    expect(entry?.data.elements).toHaveLength(OVERPASS_OUTPUT_LIMIT);
    expect(entry?.data.elements[0]).toEqual({
      type: "way",
      id: 0,
      center: { lat: 30, lon: -97 },
      tags: full[0].tags,
    });

    const cached = await queryOverpassDetailed("dentist", 30, -97);
    expect(cached).toMatchObject({ cache: "fresh", truncated: true });
  });

  it("fails open: a failing cache read or write never fails discovery", async () => {
    vi.mocked(readCacheEntry).mockRejectedValue(new Error("KV down"));
    vi.mocked(writeCache).mockRejectedValue(new Error("KV down"));
    const fetchMock = vi.fn().mockResolvedValue(response(elementsBody(elements)));
    vi.stubGlobal("fetch", fetchMock);

    const result = await queryOverpassDetailed("dentist", 30, -97);
    expect(result.elements).toEqual(elements);
    expect(result.cache).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses KV when configured: namespaced key, 14-day expiry, hit served without Overpass", async () => {
    setClock(T0);
    process.env.KV_REST_API_URL = "https://kv.test";
    process.env.KV_REST_API_TOKEN = "token";
    const kv = new Map<string, string>();
    const kvCommands: unknown[][] = [];
    const overpassCalls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        if (url === "https://kv.test") {
          const command = JSON.parse(String(init.body)) as unknown[];
          kvCommands.push(command);
          let result: unknown = null;
          if (command[0] === "GET") result = kv.get(String(command[1])) ?? null;
          if (command[0] === "SET") {
            kv.set(String(command[1]), String(command[2]));
            result = "OK";
          }
          return new Response(JSON.stringify({ result }), { status: 200 });
        }
        overpassCalls.push(url);
        return response(elementsBody(elements));
      })
    );

    const live = await queryOverpassDetailed("dentist", 30, -97);
    const key = durableCacheKey("overpass", overpassCacheKey(live.query!));
    expect(key).toMatch(/^cache:v1:overpass:[0-9a-f]{64}$/);
    expect(kvCommands).toContainEqual([
      "SET",
      key,
      expect.any(String),
      "EX",
      14 * 24 * 60 * 60,
    ]);

    vi.setSystemTime(T0 + HOUR);
    const cached = await queryOverpassDetailed("dentist", 30, -97);
    expect(overpassCalls).toEqual([PRIMARY]);
    expect(cached).toMatchObject({ cache: "fresh", accessedAt: new Date(T0).toISOString() });
    // Nothing was written to the per-instance file cache.
    await expect(fs.readdir(path.join(cacheDir, "overpass"))).rejects.toThrow();
  });
});

describe("resolveIndustry — stage 1: curated keyword map", () => {
  // industry input -> expected tag pairs (whole-string, word-pair, or single word)
  const cases: Array<[string, OsmTagPair[]]> = [
    // Food & drink
    ["restaurant", [["amenity", "restaurant"]]],
    ["bakery", [["shop", "bakery"], ["craft", "bakery"]]],
    ["brewery", [["craft", "brewery"]]],
    ["ice cream", [["amenity", "ice_cream"], ["shop", "ice_cream"]]],
    // Health & medical
    ["dentist", [["amenity", "dentist"], ["healthcare", "dentist"]]],
    ["veterinary", [["amenity", "veterinary"], ["healthcare", "veterinary"]]],
    ["physical therapy", [["healthcare", "physiotherapist"]]],
    ["chiropractor", [["healthcare", "chiropractor"]]],
    // Personal care
    ["barber", [["hairdresser", "barber"]]],
    ["barber shop", [["hairdresser", "barber"]]],
    ["tattoo", [["shop", "tattoo"]]],
    ["tattoo parlor", [["shop", "tattoo"]]],
    ["drug store", [["amenity", "pharmacy"], ["shop", "chemist"]]],
    ["pharmacy", [["amenity", "pharmacy"], ["healthcare", "pharmacy"], ["shop", "chemist"]]],
    ["bookstore", [["shop", "books"]]],
    ["book store", [["shop", "books"]]],
    ["landscaping", [["craft", "gardener"], ["craft", "landscaper"]]],
    ["auto detailing", [["service:vehicle:detailing", "yes"], ["amenity", "car_wash"]]],
    ["escape room", [["leisure", "escape_game"]]],
    // Trades (craft=*)
    ["plumber", [["craft", "plumber"]]],
    ["electrician", [["craft", "electrician"]]],
    ["roofing", [["craft", "roofer"]]],
    ["locksmith", [["craft", "locksmith"], ["shop", "locksmith"]]],
    ["chimney sweep", [["craft", "chimney_sweeper"]]],
    ["florist", [["shop", "florist"]]],
    // Professional services (office=*)
    ["lawyer", [["office", "lawyer"]]],
    ["accountant", [["office", "accountant"], ["office", "tax_advisor"]]],
    ["real estate", [["office", "estate_agent"]]],
    ["architect", [["office", "architect"]]],
    ["marketing agency", [["office", "advertising_agency"]]],
    // Retail
    ["clothing", [["shop", "clothes"]]],
    ["hardware store", [["shop", "hardware"], ["shop", "doityourself"]]],
    ["pet store", [["shop", "pet"]]],
    // Automotive
    ["auto repair", [["shop", "car_repair"]]],
    ["tire shop", [["shop", "tyres"]]],
    ["gas station", [["amenity", "fuel"]]],
    // Fitness & leisure
    ["gym", [["leisure", "fitness_centre"], ["leisure", "sports_centre"]]],
    ["yoga studio", [["sport", "yoga"]]],
    ["yoga", [["sport", "yoga"]]],
    // Education & childcare
    ["daycare", [["amenity", "childcare"], ["amenity", "kindergarten"]]],
    ["driving school", [["amenity", "driving_school"]]],
    // Lodging
    ["hotel", [["tourism", "hotel"], ["tourism", "motel"]]],
    ["hostel", [["tourism", "hostel"]]],
    // Home services & pets
    ["dry cleaning", [["shop", "dry_cleaning"]]],
    ["pet grooming", [["shop", "pet_grooming"]]],
  ];

  it.each(cases)("maps %s via the keyword map", (input, expected) => {
    const res = resolveIndustry(input);
    expect(res.stage).toBe("map");
    expect(res.tags).toEqual(expected);
  });

  it("has broad sector coverage (>=200 curated keywords)", () => {
    expect(Object.keys(OSM_CATEGORY_MAP).length).toBeGreaterThanOrEqual(200);
  });
});

describe("resolveIndustry — stage 1: matching precedence", () => {
  it("prefers a whole-string match", () => {
    const res = resolveIndustry("Auto Repair");
    expect(res).toMatchObject({ stage: "map", matched: "auto repair" });
    expect(res.tags).toEqual([["shop", "car_repair"]]);
  });

  it("matches a single meaningful word inside a longer phrase", () => {
    // "family" and "office" do not match; "dental" does.
    const res = resolveIndustry("family dental office");
    expect(res).toMatchObject({ stage: "map", matched: "dental" });
    expect(res.tags).toEqual(OSM_CATEGORY_MAP.dental);
  });

  it("prefers a more specific word-pair over its single words", () => {
    // "hair" and "salon" both exist as single keys, but the pair wins.
    const res = resolveIndustry("upscale hair salon downtown");
    expect(res).toMatchObject({ stage: "map", matched: "hair salon" });
    expect(res.tags).toEqual(OSM_CATEGORY_MAP["hair salon"]);
  });

  it("ignores generic stopwords when choosing a single-word match", () => {
    // "shop" is a stopword and must not resolve to office=office etc.
    const res = resolveIndustry("the plumbing shop");
    expect(res).toMatchObject({ stage: "map", matched: "plumbing" });
    expect(res.tags).toEqual([["craft", "plumber"]]);
  });

  it("is case- and punctuation-insensitive", () => {
    expect(resolveIndustry("  REAL-ESTATE  ").tags).toEqual([
      ["office", "estate_agent"],
    ]);
  });
});

describe("resolveIndustry — stage 2: direct tag probe", () => {
  it("probes an unmatched phrase as a literal OSM value across feature keys", () => {
    const res = resolveIndustry("kite surfing");
    expect(res.stage).toBe("probe");
    expect(res.matched).toBe("kite surfing");
    // The joined phrase is probed first, most-specific key order first.
    expect(res.tags.slice(0, 6)).toEqual([
      ["shop", "kite_surfing"],
      ["craft", "kite_surfing"],
      ["amenity", "kite_surfing"],
      ["office", "kite_surfing"],
      ["leisure", "kite_surfing"],
      ["healthcare", "kite_surfing"],
    ]);
  });

  it("probes a single unmatched word across all feature keys", () => {
    const res = resolveIndustry("falconry");
    expect(res.stage).toBe("probe");
    expect(res.tags).toEqual([
      ["shop", "falconry"],
      ["craft", "falconry"],
      ["amenity", "falconry"],
      ["office", "falconry"],
      ["leisure", "falconry"],
      ["healthcare", "falconry"],
    ]);
  });

  it("falls to the probe for an unknown multi-word industry", () => {
    const res = resolveIndustry("underwater basket weaving");
    expect(res.stage).toBe("probe");
    expect(res.tags[0]).toEqual(["shop", "underwater_basket_weaving"]);
    expect(res.tags.length).toBeGreaterThan(0);
  });
});

describe("overpassTurboUrl", () => {
  it("builds a clickable link that carries the exact query", () => {
    const query = '[out:json];nwr["shop"="books"]["name"](around:3000,37.7,-122.2);out;';
    const url = overpassTurboUrl(query);
    expect(url.startsWith("https://overpass-turbo.eu/?Q=")).toBe(true);
    expect(decodeURIComponent(url.slice("https://overpass-turbo.eu/?Q=".length))).toBe(query);
  });
});

describe("resolveIndustry — stage 3: honest floor", () => {
  const emptyCases = ["", "   ", "!!!", "the company llc", "best local services inc"];

  // Known dead ends: a head word would otherwise pick an unrelated trade.
  it.each(["garage door repair", "pet sitting"])(
    "resolves the dead end %j to no tags",
    (input) => {
      const res = resolveIndustry(input);
      expect(res.stage).toBe("none");
      expect(res.tags).toEqual([]);
    }
  );

  it.each(emptyCases)("returns no tags for %j", (input) => {
    const res = resolveIndustry(input);
    expect(res.stage).toBe("none");
    expect(res.tags).toEqual([]);
    expect(res.matched).toBeNull();
  });
});

describe("resolveOsmTags — fallback contract", () => {
  it("returns the curated tags for known types", () => {
    expect(resolveOsmTags("plumber")).toEqual(OSM_CATEGORY_MAP.plumber);
    expect(resolveOsmTags("Dentist")).toEqual(OSM_CATEGORY_MAP.dentist);
  });

  it("returns probed tags (not dead shop=yes) for unknown types", () => {
    const tags = resolveOsmTags("underwater basket weaving");
    expect(tags.length).toBeGreaterThan(0);
    // The old behaviour returned the near-dead [["shop","yes"],["office","yes"]].
    expect(tags).not.toContainEqual(["shop", "yes"]);
    expect(tags).not.toContainEqual(["office", "yes"]);
  });

  it("returns an empty array at the honest floor (all-stopword input)", () => {
    expect(resolveOsmTags("the company llc")).toEqual([]);
  });
});
