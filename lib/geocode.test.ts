import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cacheState = { store: new Map<string, unknown>() };

vi.mock("./cache", () => ({
  CACHE_TTL: { geocode: 1000, homepages: 1000, robots: 1000 },
  readCache: vi.fn(async (_bucket: string, key: string) => cacheState.store.get(key) ?? null),
  writeCache: vi.fn(async (_bucket: string, key: string, data: unknown) => {
    cacheState.store.set(key, data);
  }),
}));

vi.mock("./time-budget", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./time-budget")>();
  return {
    ...actual,
    abortableDelay: vi.fn(async () => undefined),
  };
});

import { readCache, writeCache } from "./cache";
import { chooseSettlement, geocodeMarket } from "./geocode";
import {
  AmbiguousMarketError,
  MarketNotFoundError,
  SourceUnavailableError,
} from "./pipeline-errors";
import { abortableDelay } from "./time-budget";

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as Response;
}

function place(args: {
  name: string;
  addresstype: string;
  importance: number;
  lat?: string;
  lon?: string;
  state?: string;
  iso?: string;
  countryCode?: string;
  bbox?: string[];
}) {
  return {
    display_name: args.name,
    lat: args.lat ?? "1",
    lon: args.lon ?? "2",
    addresstype: args.addresstype,
    importance: args.importance,
    boundingbox: args.bbox,
    address: {
      state: args.state,
      "ISO3166-2-lvl4": args.iso,
      country_code: args.countryCode ?? "us",
    },
  };
}

// Shape and values captured from a live Nominatim search for "Alameda, CA"
// (2026-09-24): the county outranks the city, which is why limit=1 was wrong.
const ALAMEDA_RESULTS = [
  place({
    name: "Alameda County, California, United States",
    addresstype: "county",
    importance: 0.607,
    lat: "37.6090291",
    lon: "-121.8991420",
    state: "California",
    iso: "US-CA",
  }),
  place({
    name: "Alameda, Alameda County, California, United States",
    addresstype: "city",
    importance: 0.544,
    lat: "37.7652076",
    lon: "-122.2416350",
    state: "California",
    iso: "US-CA",
    bbox: ["37.7082002", "37.8000005", "-122.3397404", "-122.2239667"],
  }),
  place({
    name: "Alameda, Saskatchewan, Canada",
    addresstype: "town",
    importance: 0.432,
    state: "Saskatchewan",
    iso: "CA-SK",
    countryCode: "ca",
  }),
  place({
    name: "Alameda, Kern County, California, United States",
    addresstype: "hamlet",
    importance: 0.391,
    state: "California",
    iso: "US-CA",
  }),
];

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
          addresstype: "city",
          importance: 0.7,
          boundingbox: ["30.0", "30.5", "-98.0", "-97.5"],
          address: { state: "Texas", "ISO3166-2-lvl4": "US-TX", country_code: "us" },
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
    expect(result.placeType).toBe("city");
    expect(result.queryUrl).toContain("limit=10");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(writeCache).toHaveBeenCalledTimes(1);
  });

  it("prefers the city over a higher-ranked county with the same name", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(ALAMEDA_RESULTS)));

    const result = await geocodeMarket("Alameda, CA");

    expect(result.label).toBe("Alameda, Alameda County, California, United States");
    expect(result.lat).toBeCloseTo(37.7652);
    expect(result.lon).toBeCloseTo(-122.2416);
    expect(result.placeType).toBe("city");
  });

  it("rejects a market that only matches a county or state", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([ALAMEDA_RESULTS[0]]));
    vi.stubGlobal("fetch", fetchMock);

    await expect(geocodeMarket("Alameda County, CA")).rejects.toMatchObject({
      code: "MARKET_NOT_FOUND",
      status: 422,
      message: expect.stringMatching(/not a city or town/),
    });
  });

  it("returns AMBIGUOUS_MARKET when comparable places in different regions match", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse([
          place({ name: "Springfield, Illinois", addresstype: "city", importance: 0.62, state: "Illinois", iso: "US-IL" }),
          place({ name: "Springfield, Massachusetts", addresstype: "city", importance: 0.6, state: "Massachusetts", iso: "US-MA" }),
          place({ name: "Springfield, Missouri", addresstype: "city", importance: 0.58, state: "Missouri", iso: "US-MO" }),
        ])
      )
    );

    const error = await geocodeMarket("Springfield, US").catch((err) => err);
    expect(error).toBeInstanceOf(AmbiguousMarketError);
    expect(error).toMatchObject({ code: "AMBIGUOUS_MARKET", status: 422 });
    expect((error as AmbiguousMarketError).candidates).toHaveLength(3);
    expect(cacheState.store.size).toBe(0);
  });

  it("uses the region to pick among homonyms instead of flagging ambiguity", () => {
    const chosen = chooseSettlement("Springfield, MO", [
      place({ name: "Springfield, Illinois", addresstype: "city", importance: 0.62, state: "Illinois", iso: "US-IL" }),
      place({ name: "Springfield, Missouri", addresstype: "city", importance: 0.58, state: "Missouri", iso: "US-MO" }),
    ]);
    expect(chosen.display_name).toBe("Springfield, Missouri");
  });

  it("returns a cached result without calling fetch", async () => {
    cacheState.store.set("v3:nominatim:austin, tx", {
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

  it("retries a 5xx once, after at least a one-second backoff", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, false, 503));
    vi.stubGlobal("fetch", fetchMock);

    await expect(geocodeMarket("Nowhere Town, TX")).rejects.toMatchObject({
      code: "SOURCE_UNAVAILABLE",
      status: 503,
      source: "nominatim",
    } satisfies Partial<SourceUnavailableError>);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(abortableDelay).toHaveBeenCalledTimes(1);
    expect(vi.mocked(abortableDelay).mock.calls[0][0]).toBeGreaterThanOrEqual(1_000);
  });

  it.each([403, 429])("does not retry an HTTP %i usage-policy rejection", async (status) => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, false, status));
    vi.stubGlobal("fetch", fetchMock);

    await expect(geocodeMarket("Policy Town, TX")).rejects.toBeInstanceOf(
      SourceUnavailableError
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(abortableDelay).not.toHaveBeenCalled();
  });

  it("skips the retry when the remaining budget cannot fit the backoff", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, false, 503));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      geocodeMarket("Tight Town, TX", { budgetMs: 1_500 })
    ).rejects.toBeInstanceOf(SourceUnavailableError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws MARKET_NOT_FOUND without retrying a valid empty result", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    await expect(geocodeMarket("Empty Results Town, TX")).rejects.toMatchObject({
      code: "MARKET_NOT_FOUND",
      status: 422,
      retryable: false,
    } satisfies Partial<MarketNotFoundError>);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws SOURCE_UNAVAILABLE when fetch throws", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("The operation was aborted"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(geocodeMarket("Timeout Town, TX")).rejects.toBeInstanceOf(
      SourceUnavailableError
    );
  });

  it("honors an already-canceled parent budget with typed SOURCE_UNAVAILABLE", async () => {
    const controller = new AbortController();
    controller.abort(new Error("request deadline"));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      geocodeMarket("Canceled Town, TX", {
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
    cacheState.store.set("v3:nominatim:cached town, tx", {
      label: "Synthetic",
      lat: 1,
      lon: 2,
      source: "mock",
    });
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse([
        { display_name: "Real Town", lat: "3", lon: "4", addresstype: "town", importance: 0.3 },
      ])
    );
    vi.stubGlobal("fetch", fetchMock);

    expect((await geocodeMarket("Cached Town, TX")).source).toBe("nominatim");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
