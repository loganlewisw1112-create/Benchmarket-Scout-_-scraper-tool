import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./time-budget", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./time-budget")>();
  return {
    ...actual,
    abortableDelay: vi.fn(async () => undefined),
  };
});

import {
  OSM_CATEGORY_MAP,
  queryOverpass,
  queryOverpassDetailed,
  resolveIndustry,
  resolveOsmTags,
  type OsmTagPair,
} from "./overpass";
import { SourceUnavailableError } from "./pipeline-errors";

function response(body: string, ok = true, status = 200) {
  return { ok, status, text: async () => body } as Response;
}

describe("queryOverpass", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns elements from the first endpoint on success", async () => {
    const elements = [{ type: "node", id: 1, tags: { name: "Test" } }];
    const fetchMock = vi.fn().mockResolvedValue(response(JSON.stringify({ elements })));
    vi.stubGlobal("fetch", fetchMock);

    const result = await queryOverpassDetailed("dentist", 30, -97);

    expect(result.elements).toEqual(elements);
    expect(result.endpoint).toBe(
      "https://overpass-api.de/api/interpreter"
    );
    expect(Number.isNaN(Date.parse(result.accessedAt))).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://overpass-api.de/api/interpreter");
  });

  it("fails over to the second endpoint after the first is exhausted", async () => {
    const elements = [{ type: "node", id: 2, tags: { name: "Second" } }];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response("", false, 504))
      .mockResolvedValueOnce(response("", false, 504))
      .mockResolvedValueOnce(response("", false, 504))
      .mockResolvedValue(response(JSON.stringify({ elements })));
    vi.stubGlobal("fetch", fetchMock);

    const result = await queryOverpassDetailed("dentist", 30, -97);

    expect(result.elements).toEqual(elements);
    expect(result.endpoint).toBe(
      "https://overpass.private.coffee/api/interpreter"
    );
    expect(Number.isNaN(Date.parse(result.accessedAt))).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[3][0]).toBe("https://overpass.private.coffee/api/interpreter");
  });

  it("throws after exhausting all endpoints and attempts", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response("", false, 500));
    vi.stubGlobal("fetch", fetchMock);

    await expect(queryOverpass("dentist", 30, -97)).rejects.toMatchObject({
      code: "SOURCE_UNAVAILABLE",
      status: 503,
      source: "overpass",
    } satisfies Partial<SourceUnavailableError>);
    expect(fetchMock).toHaveBeenCalledTimes(6); // 2 endpoints x 3 attempts
  });

  it("treats a non-JSON response as a failure and retries", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response("not json"))
      .mockResolvedValue(response(JSON.stringify({ elements: [] })));
    vi.stubGlobal("fetch", fetchMock);

    const result = await queryOverpass("dentist", 30, -97);
    expect(result).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("includes one clause per resolved tag pair in the query", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(JSON.stringify({ elements: [] })));
    vi.stubGlobal("fetch", fetchMock);

    await queryOverpass("dentist", 41.88, -87.63);

    const body = fetchMock.mock.calls[0][1].body as string;
    const query = decodeURIComponent(body.replace(/^data=/, ""));
    expect(query).toContain(`nwr["amenity"="dentist"](around:18000,41.88,-87.63);`);
    expect(query).toContain(`nwr["healthcare"="dentist"](around:18000,41.88,-87.63);`);
  });

  it("honest floor: never fires a network request when nothing resolves", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    // "the company" is entirely generic stopwords -> honest floor (no tags).
    const result = await queryOverpass("the company llc", 41.88, -87.63);

    expect(result).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("distinguishes a successful zero-result response from transport failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(response(JSON.stringify({ elements: [] })))
    );
    await expect(queryOverpass("dentist", 30, -97)).resolves.toEqual([]);
  });

  it("retries a malformed HTTP-200 payload instead of treating it as zero results", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(JSON.stringify({ remark: "runtime error" })))
      .mockResolvedValue(response(JSON.stringify({ elements: [] })));
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
    expect(fetchMock).toHaveBeenCalledTimes(6);
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
    const fetchMock = vi.fn().mockResolvedValue(response(JSON.stringify({ elements: [] })));
    vi.stubGlobal("fetch", fetchMock);

    // A long unmatched phrase probes many keys; the query stays capped.
    await queryOverpass("alpha bravo charlie delta echo foxtrot", 41.88, -87.63);

    const body = fetchMock.mock.calls[0][1].body as string;
    const query = decodeURIComponent(body.replace(/^data=/, ""));
    const clauseCount = (query.match(/nwr\[/g) ?? []).length;
    expect(clauseCount).toBeLessThanOrEqual(24);
    expect(clauseCount).toBeGreaterThan(0);
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
    ["barber", [["shop", "hairdresser"]]],
    ["tattoo", [["shop", "tattoo"]]],
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
    ["yoga studio", [["leisure", "fitness_centre"]]],
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
    const res = resolveIndustry("car wash");
    expect(res.stage).toBe("probe");
    expect(res.matched).toBe("car wash");
    // The joined phrase is probed first, most-specific key order first.
    expect(res.tags.slice(0, 6)).toEqual([
      ["shop", "car_wash"],
      ["craft", "car_wash"],
      ["amenity", "car_wash"],
      ["office", "car_wash"],
      ["leisure", "car_wash"],
      ["healthcare", "car_wash"],
    ]);
    // The real tag (amenity=car_wash) is present for the live query to hit.
    expect(res.tags).toContainEqual(["amenity", "car_wash"]);
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

describe("resolveIndustry — stage 3: honest floor", () => {
  const emptyCases = ["", "   ", "!!!", "the company llc", "best local services inc"];

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
