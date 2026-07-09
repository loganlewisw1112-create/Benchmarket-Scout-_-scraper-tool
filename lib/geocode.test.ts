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
    cacheState.store.set("nominatim:austin, tx", {
      label: "Cached Austin",
      lat: 1,
      lon: 2,
      source: "nominatim",
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await geocodeMarket("Austin, TX");

    expect(result.label).toBe("Cached Austin");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readCache).toHaveBeenCalled();
  });

  it("falls back to mock coordinates when Nominatim returns a non-ok status twice", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, false, 503));
    vi.stubGlobal("fetch", fetchMock);

    const result = await geocodeMarket("Nowhere Town");

    expect(result.source).toBe("mock");
    expect(result.label).toContain("approximate, fallback data");
    expect(fetchMock).toHaveBeenCalledTimes(2); // MAX_ATTEMPTS
  }, 3000);

  it("falls back to mock coordinates when results are empty", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    const result = await geocodeMarket("Empty Results Town");

    expect(result.source).toBe("mock");
  }, 3000);

  it("falls back to mock coordinates when fetch throws (e.g. abort/timeout)", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("The operation was aborted"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await geocodeMarket("Timeout Town");

    expect(result.source).toBe("mock");
  }, 3000);
});
