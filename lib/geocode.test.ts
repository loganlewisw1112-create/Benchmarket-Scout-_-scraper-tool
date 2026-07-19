import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cacheState = { store: new Map<string, unknown>() };

vi.mock("./cache", () => ({
  CACHE_TTL: { geocode: 1000, homepages: 1000, robots: 1000 },
  readCache: vi.fn(async (_bucket: string, key: string) => cacheState.store.get(key) ?? null),
  writeCache: vi.fn(async (_bucket: string, key: string, data: unknown) => {
    cacheState.store.set(key, data);
  }),
}));

import { readCache, writeCache } from "./cache";
import { geocodeMarket } from "./geocode";
import { MarketNotFoundError, SourceUnavailableError } from "./pipeline-errors";

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as Response;
}

describe("geocodeMarket", () => {
  beforeEach(() => {
    cacheState.store.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns a parsed result on success and writes it to cache", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse([
        {
          display_name: "Austin, TX, USA",
          lat: "30.2672",
          lon: "-97.7431",
          boundingbox: ["30.0", "30.5", "-98.0", "-97.5"],
        },
      ])
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await geocodeMarket("Austin, TX");

    expect(result.source).toBe("nominatim");
    expect(result.label).toBe("Austin, TX, USA");
    expect(result.lat).toBeCloseTo(30.2672);
    expect(result.lon).toBeCloseTo(-97.7431);
    expect(result.boundingBox).toEqual([30.0, 30.5, -98.0, -97.5]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(writeCache).toHaveBeenCalledTimes(1);
  });

  it("returns a cached result without calling fetch", async () => {
    cacheState.store.set("v2:nominatim:austin, tx", {
      label: "Cached Austin",
      lat: 1,
      lon: 2,
      source: "nominatim",
      accessedAt: "2026-07-19T10:00:00.000Z",
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await geocodeMarket("Austin, TX");

    expect(result.label).toBe("Cached Austin");
    expect(result.accessedAt).toBe("2026-07-19T10:00:00.000Z");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readCache).toHaveBeenCalled();
  });

  it("throws SOURCE_UNAVAILABLE when Nominatim returns a non-ok status twice", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, false, 503));
    vi.stubGlobal("fetch", fetchMock);

    await expect(geocodeMarket("Nowhere Town")).rejects.toMatchObject({
      code: "SOURCE_UNAVAILABLE",
      status: 503,
      source: "nominatim",
    } satisfies Partial<SourceUnavailableError>);
    expect(fetchMock).toHaveBeenCalledTimes(2); // MAX_ATTEMPTS
  }, 3000);

  it("throws MARKET_NOT_FOUND without retrying a valid empty result", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    await expect(geocodeMarket("Empty Results Town")).rejects.toMatchObject({
      code: "MARKET_NOT_FOUND",
      status: 422,
      retryable: false,
    } satisfies Partial<MarketNotFoundError>);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  }, 3000);

  it("throws SOURCE_UNAVAILABLE when fetch throws", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("The operation was aborted"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(geocodeMarket("Timeout Town")).rejects.toBeInstanceOf(
      SourceUnavailableError
    );
  }, 3000);

  it("honors an already-canceled parent budget with typed SOURCE_UNAVAILABLE", async () => {
    const controller = new AbortController();
    controller.abort(new Error("request deadline"));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      geocodeMarket("Canceled Town", {
        signal: controller.signal,
        budgetMs: 5_000,
      })
    ).rejects.toMatchObject({
      code: "SOURCE_UNAVAILABLE",
      status: 503,
      source: "nominatim",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ignores a stale synthetic cache entry", async () => {
    cacheState.store.set("v2:nominatim:cached town", {
      label: "Synthetic",
      lat: 1,
      lon: 2,
      source: "mock",
    });
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse([{ display_name: "Real Town", lat: "3", lon: "4" }])
    );
    vi.stubGlobal("fetch", fetchMock);

    expect((await geocodeMarket("Cached Town")).source).toBe("nominatim");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
