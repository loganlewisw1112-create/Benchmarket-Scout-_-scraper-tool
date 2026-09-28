import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discoverCompetitors } from "./discover";
import {
  loadOsmIndex,
  osmIndexCovers,
  parseOsmIndex,
  queryOsmIndex,
  resetOsmIndexForTests,
} from "./osm-index";

const BERKELEY = { lat: 37.8708393, lon: -122.272863 };

function indexDoc(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    region: "bayarea",
    source: {
      name: "OpenStreetMap contributors, via Geofabrik",
      url: "https://download.geofabrik.de/north-america/us/california/norcal.html",
      license: "ODbL 1.0",
    },
    osmTimestamp: new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString(),
    builtAt: new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString(),
    bbox: [36.85, -123.15, 38.65, -121.2],
    count: 5,
    elements: [
      ["n", 1, 37.86612, -122.25879, { name: "Moe's Books", shop: "books", website: "https://www.moesbooks.com/" }],
      ["n", 2, 37.8676, -122.2595, { name: "Revolution Books", shop: "books" }],
      ["w", 3, 37.8765, -122.2689, { name: "Big Chain Books", shop: "books", brand: "Chain", "brand:wikidata": "Q1" }],
      ["n", 4, 37.8716, -122.2727, { name: "Corner Cafe", amenity: "cafe" }],
      // 30 km away: outside any Berkeley-sized radius.
      ["n", 5, 37.6, -122.2, { name: "Far Books", shop: "books" }],
    ],
    ...overrides,
  };
}

const gz = (doc: unknown) => zlib.gzipSync(JSON.stringify(doc));

describe("osmIndexCovers", () => {
  it("covers Bay Area circles and rejects ones that leave the region", () => {
    expect(osmIndexCovers(BERKELEY.lat, BERKELEY.lon, 6_000)).toBe(true);
    expect(osmIndexCovers(47.6038, -122.33, 8_000)).toBe(false); // Seattle
    // Near the southern edge: a 12 km circle crosses it.
    expect(osmIndexCovers(36.9, -122.0308, 12_000)).toBe(false);
  });
});

describe("queryOsmIndex", () => {
  it("returns named elements matching a tag pair within the radius, like Overpass `out center`", () => {
    const index = parseOsmIndex(JSON.stringify(indexDoc()));
    const found = queryOsmIndex(index, [["shop", "books"]], BERKELEY.lat, BERKELEY.lon, 5_900);
    expect(found.map((e) => e.id).sort()).toEqual([1, 2, 3]);
    expect(found.find((e) => e.id === 1)).toMatchObject({ type: "node", lat: 37.86612, lon: -122.25879 });
    expect(found.find((e) => e.id === 3)).toMatchObject({
      type: "way",
      center: { lat: 37.8765, lon: -122.2689 },
    });
  });

  it("ignores elements whose tags do not match", () => {
    const index = parseOsmIndex(JSON.stringify(indexDoc()));
    const found = queryOsmIndex(index, [["amenity", "cafe"]], BERKELEY.lat, BERKELEY.lon, 5_900);
    expect(found.map((e) => e.id)).toEqual([4]);
  });
});

describe("parseOsmIndex", () => {
  it("rejects malformed documents", () => {
    expect(() => parseOsmIndex(JSON.stringify({ version: 2 }))).toThrow();
    expect(() => parseOsmIndex(JSON.stringify(indexDoc({ osmTimestamp: "nope" })))).toThrow();
  });
});

describe("loadOsmIndex", () => {
  beforeEach(() => {
    delete process.env.OSM_INDEX_DISABLED;
    // No bundled copy unless a test provides one.
    process.env.OSM_INDEX_FILE = path.join(os.tmpdir(), "no-such-osm-index.json.gz");
    resetOsmIndexForTests();
  });

  it("uses a recent bundled copy without any network call", async () => {
    const file = path.join(os.tmpdir(), `osm-index-test-${process.pid}.json.gz`);
    fs.writeFileSync(file, gz(indexDoc()));
    process.env.OSM_INDEX_FILE = file;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const index = await loadOsmIndex();
    expect(index?.elements).toHaveLength(5);
    expect(fetchMock).not.toHaveBeenCalled();
    fs.rmSync(file, { force: true });
  });

  it("downloads when the bundled copy is older than 10 days, and falls back to it if that fails", async () => {
    const file = path.join(os.tmpdir(), `osm-index-test-old-${process.pid}.json.gz`);
    const old = indexDoc({ osmTimestamp: new Date(Date.now() - 20 * 24 * 3600 * 1000).toISOString() });
    fs.writeFileSync(file, gz(old));
    process.env.OSM_INDEX_FILE = file;
    const fetchMock = vi.fn(async () => new Response("nope", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const index = await loadOsmIndex();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(index?.osmTimestamp).toBe(old.osmTimestamp);
    fs.rmSync(file, { force: true });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    resetOsmIndexForTests();
  });

  it("downloads once and reuses the copy on a warm instance", async () => {
    const fetchMock = vi.fn(async () => new Response(gz(indexDoc())));
    vi.stubGlobal("fetch", fetchMock);
    const first = await loadOsmIndex();
    const second = await loadOsmIndex();
    expect(first?.elements).toHaveLength(5);
    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns null, and backs off, when the download fails", async () => {
    const fetchMock = vi.fn(async () => new Response("nope", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await loadOsmIndex()).toBeNull();
    expect(await loadOsmIndex()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses an index older than the maximum age", async () => {
    const stale = indexDoc({ osmTimestamp: new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString() });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(gz(stale))));
    expect(await loadOsmIndex()).toBeNull();
  });

  it("is off when OSM_INDEX_DISABLED is true", async () => {
    process.env.OSM_INDEX_DISABLED = "true";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await loadOsmIndex()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("discoverCompetitors with the index", () => {
  beforeEach(() => {
    delete process.env.OSM_INDEX_DISABLED;
    process.env.OSM_INDEX_FILE = path.join(os.tmpdir(), "no-such-osm-index.json.gz");
    resetOsmIndexForTests();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    resetOsmIndexForTests();
  });

  it("serves a Bay Area market from the extract without calling Overpass, dated by the OSM timestamp", async () => {
    const doc = indexDoc();
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("interpreter")) throw new Error("Overpass must not be called");
      return new Response(gz(doc));
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await discoverCompetitors({
      businessType: "book store",
      userBusinessName: "Moe's Books",
      userDomain: "moesbooks.com",
      lat: BERKELEY.lat,
      lon: BERKELEY.lon,
      bbox: [37.8356877, 37.9066896, -122.3686918, -122.2341962],
    });

    expect(result.discoverySource).toBe("osm-extract");
    expect(result.accessedAt).toBe(doc.osmTimestamp);
    expect(result.extract?.url).toContain("geofabrik");
    expect(result.userMatch?.name).toBe("Moe's Books");
    // Nearest first: the chain location is ~0.7 km out, Revolution ~1.2 km.
    expect(result.candidates.map((c) => c.name)).toEqual(["Big Chain Books", "Revolution Books"]);
    expect(result.candidates[0].isChain).toBe(true);
    expect(result.candidates[0].distanceKm).toBeLessThan(result.candidates[1].distanceKm!);
  });

  it("falls back to live Overpass outside the Bay Area", async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("interpreter")) {
        return new Response(JSON.stringify({ elements: [] }), {
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error("the index must not be downloaded for Seattle");
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await discoverCompetitors({
      businessType: "escape room",
      userBusinessName: "Puzzle Break",
      lat: 47.6038321,
      lon: -122.330062,
      bbox: [47.4810022, 47.7341503, -122.459696, -122.224433],
    });
    expect(result.discoverySource).toBe("overpass");
  });
});
