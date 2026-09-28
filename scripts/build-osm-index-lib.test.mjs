import { describe, expect, it } from "vitest";
import {
  buildIndex,
  centerOf,
  keepTags,
  parseElementId,
  toIndexElement,
} from "./build-osm-index-lib.mjs";

const BBOX = [36.85, -123.15, 38.65, -121.2];

const line = (feature) => `\u001e${JSON.stringify(feature)}`;

describe("parseElementId", () => {
  it("reads type_id ids and osmium area ids", () => {
    expect(parseElementId("n123")).toEqual({ type: "n", id: 123 });
    expect(parseElementId("w456")).toEqual({ type: "w", id: 456 });
    expect(parseElementId("r7")).toEqual({ type: "r", id: 7 });
    expect(parseElementId("a912")).toEqual({ type: "w", id: 456 });
    expect(parseElementId("a15")).toEqual({ type: "r", id: 7 });
    expect(parseElementId("x1")).toBeNull();
  });
});

describe("centerOf", () => {
  it("uses a point as-is and a polygon's bbox center (Overpass `out center`)", () => {
    expect(centerOf({ type: "Point", coordinates: [-122.27, 37.87] })).toEqual({
      lat: 37.87,
      lon: -122.27,
    });
    expect(
      centerOf({
        type: "Polygon",
        coordinates: [[[-122.3, 37.8], [-122.2, 37.8], [-122.2, 37.9], [-122.3, 37.8]]],
      })
    ).toEqual({ lat: 37.849999999999994, lon: -122.25 });
  });
});

describe("keepTags", () => {
  it("drops noise tags and keeps everything discovery or scoring reads", () => {
    expect(
      keepTags({
        "@id": "n1",
        name: "Moe's Books",
        "name:de": "Moes Bücher",
        shop: "books",
        website: "https://www.moesbooks.com/",
        "addr:street": "Telegraph Avenue",
        "payment:cash": "yes",
        "brand:wikidata": "Q1",
        source: "survey",
      })
    ).toEqual({
      name: "Moe's Books",
      shop: "books",
      website: "https://www.moesbooks.com/",
      "addr:street": "Telegraph Avenue",
      "brand:wikidata": "Q1",
    });
  });
});

describe("toIndexElement", () => {
  const book = {
    type: "Feature",
    id: "n42",
    geometry: { type: "Point", coordinates: [-122.2587912, 37.8661234] },
    properties: { name: "Moe's Books", shop: "books" },
  };

  it("keeps a named business inside the bbox, rounded to ~1 m", () => {
    expect(toIndexElement(book, BBOX)).toEqual([
      "n",
      42,
      37.86612,
      -122.25879,
      { name: "Moe's Books", shop: "books" },
    ]);
  });

  it("rejects unnamed, uncategorized, and out-of-region elements", () => {
    expect(toIndexElement({ ...book, properties: { shop: "books" } }, BBOX)).toBeNull();
    expect(toIndexElement({ ...book, properties: { name: "Bench" } }, BBOX)).toBeNull();
    expect(
      toIndexElement(
        { ...book, geometry: { type: "Point", coordinates: [-118.24, 34.05] } },
        BBOX
      )
    ).toBeNull();
  });
});

describe("buildIndex", () => {
  it("dedupes, sorts, counts rejects, and records provenance", () => {
    const lines = [
      line({
        type: "Feature",
        id: "w9",
        geometry: {
          type: "Polygon",
          coordinates: [[[-122.3, 37.8], [-122.2, 37.8], [-122.2, 37.9], [-122.3, 37.8]]],
        },
        properties: { name: "Big Market", shop: "supermarket" },
      }),
      line({
        type: "Feature",
        id: "n2",
        geometry: { type: "Point", coordinates: [-122.27, 37.87] },
        properties: { name: "Cafe", amenity: "cafe" },
      }),
      line({
        type: "Feature",
        id: "n2",
        geometry: { type: "Point", coordinates: [-122.27, 37.87] },
        properties: { name: "Cafe", amenity: "cafe" },
      }),
      "not json",
      "",
    ];
    const { index, rejected } = buildIndex(lines, {
      bbox: BBOX,
      osmTimestamp: "2026-09-27T20:21:02.000Z",
      builtAt: "2026-09-28T06:30:00.000Z",
      source: { name: "test", url: "https://example.org", license: "ODbL" },
    });
    expect(index.count).toBe(2);
    expect(index.elements.map((e) => `${e[0]}${e[1]}`)).toEqual(["n2", "w9"]);
    expect(index.elements[1].slice(2, 4)).toEqual([37.85, -122.25]);
    expect(rejected).toBe(1);
    expect(index.osmTimestamp).toBe("2026-09-27T20:21:02.000Z");
  });
});
