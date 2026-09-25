import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dedupeCandidates,
  discoverCompetitors,
  discoveryRadiusKm,
  domainRoot,
  elementToCandidate,
  flagChains,
  normalizeBusinessName,
  removeUserBusiness,
  siteIdentity,
  splitUserBusiness,
  type DiscoveredCandidate,
} from "./discover";
import type { OverpassElement } from "./overpass";

function makeCandidate(args: {
  name: string;
  website?: string;
  phone?: string;
  address?: string;
  lat?: number;
  lon?: number;
}): DiscoveredCandidate {
  return {
    id: `test-${args.name}`,
    osmElementUrl: `https://www.openstreetmap.org/node/${encodeURIComponent(args.name)}`,
    name: args.name,
    website: args.website,
    phone: args.phone,
    address: args.address,
    lat: args.lat,
    lon: args.lon,
    source: "overpass",
    priorityScore: 0,
  };
}

describe("elementToCandidate", () => {
  it("returns null for unnamed elements", () => {
    const el: OverpassElement = {
      type: "node",
      id: 1,
      tags: { amenity: "dentist" },
    };
    expect(elementToCandidate(el, "dentist")).toBeNull();
  });

  it("extracts fields and scores priority from tag completeness", () => {
    const el: OverpassElement = {
      type: "node",
      id: 7,
      lat: 30.27,
      lon: -97.74,
      tags: {
        name: "Bright Dental",
        website: "https://brightdental.example.org",
        phone: "555-111-2222",
        "addr:street": "Main St",
        amenity: "dentist",
      },
    };

    const candidate = elementToCandidate(el, "dentist");
    expect(candidate).not.toBeNull();
    expect(candidate!.id).toBe("osm-node-7");
    expect(candidate!.osmElementUrl).toBe(
      "https://www.openstreetmap.org/node/7"
    );
    expect(candidate!.website).toBe("https://brightdental.example.org/");
    expect(candidate!.phone).toBe("555-111-2222");
    expect(candidate!.address).toBe("Main St");
    expect(candidate!.lat).toBe(30.27);
    expect(candidate!.lon).toBe(-97.74);
    // website 30 + category match 20 + phone 20 + address 15 + tag count 2.5
    expect(candidate!.priorityScore).toBe(87.5);
  });

  it("falls back to contact:website when website is absent", () => {
    const el: OverpassElement = {
      type: "way",
      id: 42,
      center: { lat: 30, lon: -97 },
      tags: {
        name: "Riverside Clinic",
        "contact:website": "https://riverside.example.org",
      },
    };

    const candidate = elementToCandidate(el, "dentist");
    expect(candidate!.website).toBe("https://riverside.example.org/");
    expect(candidate!.lat).toBe(30);
    expect(candidate!.lon).toBe(-97);
  });

  it("normalizes scheme-less websites and omits unsupported protocols", () => {
    const normalized = elementToCandidate(
      {
        type: "node",
        id: 10,
        tags: { name: "Plain Domain", website: "www.example.com" },
      },
      "dentist"
    );
    const invalid = elementToCandidate(
      {
        type: "node",
        id: 11,
        tags: { name: "FTP Domain", website: "ftp://example.com" },
      },
      "dentist"
    );

    expect(normalized?.website).toBe("https://www.example.com/");
    expect(invalid?.website).toBeUndefined();
  });
});

describe("removeUserBusiness", () => {
  it("filters the user's business by normalized name or domain", () => {
    const candidates = [
      makeCandidate({ name: "JOE'S PLUMBING!!" }),
      makeCandidate({
        name: "Rival Co",
        website: "http://acme-plumbing.example/about",
      }),
      makeCandidate({
        name: "Keeper Plumbing",
        website: "https://keeper-plumbing.example",
      }),
    ];

    const remaining = removeUserBusiness(
      candidates,
      "Joe's Plumbing",
      "https://www.acme-plumbing.example"
    );

    expect(remaining.map((c) => c.name)).toEqual(["Keeper Plumbing"]);
  });

  it("keeps everything when nothing matches", () => {
    const candidates = [
      makeCandidate({ name: "A Co" }),
      makeCandidate({ name: "B Co", website: "https://b-company.example" }),
    ];
    expect(
      removeUserBusiness(candidates, "Unrelated Name", "https://c-company.example")
    ).toHaveLength(2);
  });

  it("matches names across straight and curly apostrophes and branch suffixes", () => {
    const candidates = [
      makeCandidate({ name: "Moe’s Books - Telegraph Ave", lat: 37.86, lon: -122.26 }),
      makeCandidate({ name: "Pegasus Books" }),
    ];
    const { competitors, userMatch } = splitUserBusiness(candidates, "Moe's Books");
    expect(competitors.map((c) => c.name)).toEqual(["Pegasus Books"]);
    expect(userMatch?.name).toBe("Moe’s Books - Telegraph Ave");
    expect(normalizeBusinessName("Al’s Barbershop")).toBe(
      normalizeBusinessName("Al's Barbershop")
    );
  });

  it("never removes other businesses that share a social or site-builder host", () => {
    const candidates = [
      makeCandidate({ name: "Other Cuts", website: "https://www.facebook.com/othercuts" }),
      makeCandidate({ name: "Bare Page", website: "https://facebook.com/" }),
      makeCandidate({ name: "Wix Shop", website: "https://othershop.wixsite.com/home" }),
      makeCandidate({ name: "Mine On Facebook", website: "https://m.facebook.com/alsbarbers/" }),
    ];
    const remaining = removeUserBusiness(
      candidates,
      "Al's Barbers",
      "https://www.facebook.com/alsbarbers"
    );
    expect(remaining.map((c) => c.name)).toEqual(["Other Cuts", "Bare Page", "Wix Shop"]);
  });

  it.each([
    ["com.sg", "https://myownbakery.com.sg/", ["cafealpha.com.sg", "bakerybeta.com.sg"]],
    ["co.il", "https://myownbakery.co.il/", ["cafealpha.co.il", "bakerybeta.co.il"]],
    ["com.au", "https://myownbakery.com.au/", ["cafealpha.com.au", "bakerybeta.com.au"]],
  ])(
    "only removes the user's own host under a %s suffix",
    (_suffix, userSite, [alphaHost, betaHost]) => {
      const candidates = [
        makeCandidate({ name: "Cafe Alpha", website: `https://${alphaHost}/` }),
        makeCandidate({ name: "Bakery Beta", website: `https://www.${betaHost}/menu` }),
        makeCandidate({ name: "Gamma Bakes", website: "https://gamma.sg/" }),
        makeCandidate({ name: "Listed Mine", website: userSite.replace("https://", "https://www.") }),
      ];
      const { competitors, userMatch } = splitUserBusiness(
        candidates,
        "My Own Bakery",
        userSite
      );
      expect(competitors.map((c) => c.name)).toEqual([
        "Cafe Alpha",
        "Bakery Beta",
        "Gamma Bakes",
      ]);
      expect(userMatch?.name).toBe("Listed Mine");
    }
  );

  it("never adopts another business as the user's listing by a shared suffix", () => {
    const { competitors, userMatch } = splitUserBusiness(
      [makeCandidate({ name: "Cafe Alpha", website: "https://cafealpha.com.sg/" })],
      "My Own Bakery",
      "https://myownbakery.com.sg/"
    );
    expect(competitors.map((c) => c.name)).toEqual(["Cafe Alpha"]);
    expect(userMatch).toBeUndefined();
  });
});

describe("siteIdentity", () => {
  it("uses the tenant path on shared hosts and the registrable domain elsewhere", () => {
    expect(siteIdentity("https://facebook.com/")).toBeUndefined();
    expect(siteIdentity("https://sites.google.com/")).toBeUndefined();
    expect(siteIdentity("https://www.facebook.com/AlsBarbers/")).toBe(
      "site:facebook.com/alsbarbers"
    );
    expect(siteIdentity("https://als.business.site/")).toBe("site:als.business.site");
    expect(siteIdentity("https://locations.greatclips.com/ca/alameda")).toBe(
      "site:greatclips.com"
    );
    expect(siteIdentity("https://shop.example.co.uk")).toBe("site:example.co.uk");
  });

  it("keeps the registrable domain for ccTLD second levels it does not list", () => {
    expect(domainRoot("bakerya.com.sg")).toBe("bakerya.com.sg");
    expect(domainRoot("shop.cafeb.co.il")).toBe("cafeb.co.il");
    expect(domainRoot("www.lokanta.com.tr")).toBe("lokanta.com.tr");
    expect(domainRoot("ramen.ne.jp")).toBe("ramen.ne.jp");
    expect(domainRoot("locations.greatclips.com")).toBe("greatclips.com");
    expect(domainRoot("example.io")).toBe("example.io");
  });
});

describe("discoveryRadiusKm", () => {
  it("sizes the radius from the bbox and clamps it to 2-12 km", () => {
    // City of Alameda, CA bbox (~8 km across): about 4-6 km.
    const alameda = discoveryRadiusKm([37.7328, 37.8003, -122.3405, -122.2243]);
    expect(alameda).toBeGreaterThanOrEqual(3);
    expect(alameda).toBeLessThanOrEqual(7);
    expect(discoveryRadiusKm([37.7, 37.701, -122.2, -122.201])).toBe(2);
    expect(discoveryRadiusKm([37, 38, -123, -121])).toBe(12);
    expect(discoveryRadiusKm(undefined)).toBe(8);
  });
});

describe("flagChains", () => {
  it("flags brand-tagged elements and own-domain sites shared by 2+ listings", () => {
    const flagged = flagChains([
      { ...makeCandidate({ name: "Clips A", website: "https://www.greatclips.com/a" }) },
      { ...makeCandidate({ name: "Clips B", website: "https://locations.greatclips.com/b" }) },
      { ...makeCandidate({ name: "Branded" }), hasBrandTag: true, brand: "Supercuts" },
      makeCandidate({ name: "Local FB 1", website: "https://facebook.com/local1" }),
      makeCandidate({ name: "Local FB 2", website: "https://facebook.com/local2" }),
      makeCandidate({ name: "Indie", website: "https://indie-cuts.example" }),
    ]);
    expect(flagged.filter((c) => c.isChain).map((c) => c.name)).toEqual([
      "Clips A",
      "Clips B",
      "Branded",
    ]);
    expect(flagged.find((c) => c.name === "Branded")?.brand).toBe("Supercuts");
  });

  it("does not flag distinct businesses that only share a ccTLD second level", () => {
    const flagged = flagChains([
      makeCandidate({ name: "Bakery A", website: "https://bakerya.com.sg/" }),
      makeCandidate({ name: "Cafe B", website: "https://cafeb.com.sg/" }),
      makeCandidate({ name: "Deli C", website: "https://delic.co.il/" }),
      makeCandidate({ name: "Deli D", website: "https://delid.co.il/" }),
      makeCandidate({ name: "Kebab E", website: "https://kebabe.com.tr/" }),
      makeCandidate({ name: "Kebab F", website: "https://kebabf.com.tr/" }),
    ]);
    expect(flagged.filter((c) => c.isChain)).toEqual([]);
  });
});

describe("dedupeCandidates", () => {
  it("dedupes transitively and chooses a stable best candidate", () => {
    // A POI node, its building way ~40 m away, and a record sharing the
    // way's own website ~100 m away: one business.
    const candidates = [
      { ...makeCandidate({ name: "Alpha", website: "alpha.test", lat: 37.7700, lon: -122.2400 }), id: "osm-node-2", priorityScore: 10 },
      { ...makeCandidate({ name: "Alpha", website: "bridge.test", phone: "5551112222", lat: 37.7703, lon: -122.2402 }), id: "osm-node-3", priorityScore: 20 },
      { ...makeCandidate({ name: "Different", website: "bridge.test", lat: 37.7710, lon: -122.2405 }), id: "osm-node-1", priorityScore: 20 },
    ];
    expect(dedupeCandidates(candidates).map((candidate) => candidate.id)).toEqual([
      "osm-node-1",
    ]);
  });

  it("keeps same-name businesses apart unless they are close or share an address", () => {
    const far = [
      { ...makeCandidate({ name: "Subway", lat: 37.77, lon: -122.24 }), id: "osm-node-1" },
      { ...makeCandidate({ name: "Subway", lat: 37.78, lon: -122.26 }), id: "osm-node-2" },
      { ...makeCandidate({ name: "Subway" }), id: "osm-node-3" },
    ];
    expect(dedupeCandidates(far)).toHaveLength(3);

    const sameAddress = [
      { ...makeCandidate({ name: "Beta", address: "1 Main St" }), id: "osm-node-4" },
      { ...makeCandidate({ name: "Beta", address: "1 main st" }), id: "osm-node-5" },
    ];
    expect(dedupeCandidates(sameAddress)).toHaveLength(1);
  });

  it("never merges businesses on a shared host such as facebook.com", () => {
    const candidates = [
      { ...makeCandidate({ name: "One", website: "https://facebook.com/", lat: 37.77, lon: -122.24 }), id: "osm-node-1" },
      { ...makeCandidate({ name: "Two", website: "https://facebook.com/", lat: 37.7701, lon: -122.2401 }), id: "osm-node-2" },
      { ...makeCandidate({ name: "Three", website: "https://sites.google.com/view/three", lat: 37.7702, lon: -122.2402 }), id: "osm-node-3" },
    ];
    expect(dedupeCandidates(candidates)).toHaveLength(3);
  });
});

describe("discoverCompetitors", () => {
  // Discovery caches real Overpass answers; test doubles must only ever land
  // in a throwaway directory, never in the project's .cache.
  let cacheDir: string;
  beforeEach(async () => {
    cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "scout-discover-"));
    process.env.CACHE_DIR = cacheDir;
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete process.env.CACHE_DIR;
    await fs.rm(cacheDir, { recursive: true, force: true });
  });

  it("returns complete with zero candidates for a valid zero-result response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () => JSON.stringify({ elements: [] }),
      } as Response)
    );
    const result = await discoverCompetitors({
      businessType: "dentist",
      userBusinessName: "Acme",
      lat: 30,
      lon: -97,
    });
    expect(result).toMatchObject({
      candidates: [],
      discoverySource: "overpass",
      status: "complete",
      queryPerformed: true,
      endpoint: "https://overpass-api.de/api/interpreter",
    });
    expect(Number.isNaN(Date.parse(result.accessedAt))).toBe(false);
  });

  it("does not claim an Overpass query for an unresolvable industry", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await discoverCompetitors({
      businessType: "and the of",
      userBusinessName: "Acme",
      lat: 30,
      lon: -97,
    });
    expect(result).toMatchObject({
      candidates: [],
      discoverySource: "overpass",
      status: "limited",
      queryPerformed: false,
    });
    expect(result.endpoint).toBeUndefined();
    expect(Number.isNaN(Date.parse(result.accessedAt))).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns every candidate nearest first with distanceKm, and splits out the user", async () => {
    const elements = [
      { type: "node", id: 1, lat: 37.80, lon: -122.27, tags: { name: "Far Books", shop: "books", website: "https://far.example" } },
      { type: "node", id: 2, lat: 37.765, lon: -122.242, tags: { name: "Near Books", shop: "books" } },
      { type: "node", id: 3, lat: 37.766, lon: -122.243, tags: { name: "Mine Books", shop: "books", website: "https://mine.example" } },
      { type: "node", id: 4, lat: 37.77, lon: -122.25, tags: { name: "Chain Books", shop: "books", brand: "Chain Books", "brand:wikidata": "Q1" } },
    ];
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ elements }),
    } as Response);
    vi.stubGlobal("fetch", fetchMock);

    const result = await discoverCompetitors({
      businessType: "bookstore",
      userBusinessName: "Mine Books",
      userDomain: "https://www.mine.example/",
      lat: 37.7652,
      lon: -122.2416,
      bbox: [37.7328, 37.8003, -122.3405, -122.2243],
    });

    expect(result.candidates.map((c) => c.name)).toEqual([
      "Near Books",
      "Chain Books",
      "Far Books",
    ]);
    expect(result.candidates.every((c) => typeof c.distanceKm === "number")).toBe(true);
    expect(result.candidates[0].distanceKm!).toBeLessThan(result.candidates[2].distanceKm!);
    expect(result.candidates.find((c) => c.name === "Chain Books")).toMatchObject({
      isChain: true,
      brand: "Chain Books",
    });
    expect(result.userMatch?.name).toBe("Mine Books");
    expect(result.radiusKm).toBe(discoveryRadiusKm([37.7328, 37.8003, -122.3405, -122.2243]));
    expect(result.query).toContain(`around:${Math.round(result.radiusKm * 1000)},`);
    const query = decodeURIComponent(
      (fetchMock.mock.calls[0][1].body as string).replace(/^data=/, "")
    );
    expect(query).toContain('nwr["shop"="books"]["name"]');
  });

  it("passes a cached competitor list through with its original accessedAt", async () => {
    const elements = [
      { type: "node", id: 21, lat: 30.001, lon: -97.001, tags: { name: "Cached Dental", amenity: "dentist" } },
    ];
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ elements }),
    } as Response);
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers({ toFake: ["Date"] });
    const retrievedAt = Date.parse("2026-09-20T12:00:00.000Z");
    vi.setSystemTime(retrievedAt);
    const args = { businessType: "dentist", userBusinessName: "Acme", lat: 30, lon: -97 };

    const live = await discoverCompetitors(args);
    expect(live.cache).toBeUndefined();

    vi.setSystemTime(retrievedAt + 60 * 60 * 1000);
    const cached = await discoverCompetitors(args);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cached).toMatchObject({
      cache: "fresh",
      queryPerformed: true,
      accessedAt: new Date(retrievedAt).toISOString(),
      query: live.query,
    });
    expect(cached.candidates).toEqual(live.candidates);
  });
});
