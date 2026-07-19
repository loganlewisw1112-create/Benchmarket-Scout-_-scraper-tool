import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dedupeCandidates,
  discoverCompetitors,
  elementToCandidate,
  removeUserBusiness,
  type DiscoveredCandidate,
} from "./discover";
import type { OverpassElement } from "./overpass";

function makeCandidate(args: {
  name: string;
  website?: string;
  phone?: string;
}): DiscoveredCandidate {
  return {
    id: `test-${args.name}`,
    osmElementUrl: `https://www.openstreetmap.org/node/${encodeURIComponent(args.name)}`,
    name: args.name,
    website: args.website,
    phone: args.phone,
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
        website: "http://acme.example.org/about",
      }),
      makeCandidate({
        name: "Keeper Plumbing",
        website: "https://keeper.example.org",
      }),
    ];

    const remaining = removeUserBusiness(
      candidates,
      "Joe's Plumbing",
      "https://www.acme.example.org"
    );

    expect(remaining.map((c) => c.name)).toEqual(["Keeper Plumbing"]);
  });

  it("keeps everything when nothing matches", () => {
    const candidates = [
      makeCandidate({ name: "A Co" }),
      makeCandidate({ name: "B Co", website: "https://b.example.org" }),
    ];
    expect(
      removeUserBusiness(candidates, "Unrelated Name", "https://c.example.org")
    ).toHaveLength(2);
  });
});

describe("dedupeCandidates", () => {
  it("dedupes transitively and chooses a stable best candidate", () => {
    const candidates = [
      { ...makeCandidate({ name: "Alpha", website: "alpha.test" }), id: "osm-node-2", priorityScore: 10 },
      { ...makeCandidate({ name: "Alpha", website: "bridge.test", phone: "5551112222" }), id: "osm-node-3", priorityScore: 20 },
      { ...makeCandidate({ name: "Different", website: "bridge.test" }), id: "osm-node-1", priorityScore: 20 },
    ];
    expect(dedupeCandidates(candidates).map((candidate) => candidate.id)).toEqual([
      "osm-node-1",
    ]);
  });
});

describe("discoverCompetitors", () => {
  afterEach(() => vi.unstubAllGlobals());

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
});
