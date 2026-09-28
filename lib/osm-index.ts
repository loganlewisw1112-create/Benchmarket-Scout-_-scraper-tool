// Bay Area OpenStreetMap business index.
//
// Public Overpass instances were overloaded for days in September 2026, and
// every live competitor search from Vercel timed out. For markets inside the
// Bay Area, discovery now reads a weekly index built from the Geofabrik
// Northern California extract instead (.github/workflows/osm-index.yml,
// scripts/build-osm-index.mjs). It holds the same real OSM elements and tags
// an Overpass `nwr[...]["name"](around:...)` query would return, positioned
// like `out center`, and is dated by the extract's OSM timestamp, never by
// when a report ran. Markets outside the index, or any failure to load it,
// fall back to live Overpass (lib/overpass.ts).

import zlib from "node:zlib";
import { logger, serializeError } from "./logger";
import type { OsmTagPair, OverpassElement } from "./overpass";

/** south, west, north, east. Must match scripts/build-osm-index.mjs. */
export const OSM_INDEX_BBOX = [36.85, -123.15, 38.65, -121.2] as const;

export const DEFAULT_OSM_INDEX_URL =
  "https://github.com/loganlewisw1112-create/Benchmarket-Scout-_-scraper-tool/releases/download/osm-index-bayarea/bayarea-pois.json.gz";

// An index older than this is not used: the weekly build has clearly stopped,
// and live Overpass is the more current source.
export const OSM_INDEX_MAX_AGE_MS = 45 * 24 * 60 * 60 * 1000;
// A warm instance re-downloads after this, so a new weekly build is picked up.
const RELOAD_AFTER_MS = 6 * 60 * 60 * 1000;
// After a failed download, wait this long before trying again.
const RETRY_AFTER_FAILURE_MS = 5 * 60 * 1000;
const LOAD_TIMEOUT_MS = 8_000;
const CELL_DEG = 0.02;
// Same cap lib/overpass.ts applies to a single query's tag clauses.
const MAX_TAG_CLAUSES = 24;

type RawElement = [
  type: "n" | "w" | "r",
  id: number,
  lat: number,
  lon: number,
  tags: Record<string, string>,
];

export type OsmIndex = {
  osmTimestamp: string;
  builtAt: string;
  source: { name: string; url: string; license: string };
  bbox: readonly [number, number, number, number];
  elements: RawElement[];
  grid: Map<string, number[]>;
};

const TYPE_NAMES = { n: "node", w: "way", r: "relation" } as const;

let loaded: { index: OsmIndex; at: number } | null = null;
let inflight: Promise<OsmIndex | null> | null = null;
let lastFailureAt = 0;

function cellKey(lat: number, lon: number): string {
  return `${Math.floor(lat / CELL_DEG)}:${Math.floor(lon / CELL_DEG)}`;
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number) {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_008.8 * Math.asin(Math.min(1, Math.sqrt(a)));
}

function circleBox(lat: number, lon: number, radiusMeters: number) {
  const dLat = radiusMeters / 111_320;
  const dLon = radiusMeters / (111_320 * Math.max(0.01, Math.cos((lat * Math.PI) / 180)));
  return { south: lat - dLat, north: lat + dLat, west: lon - dLon, east: lon + dLon };
}

/** True when the whole search circle lies inside the index's region. */
export function osmIndexCovers(lat: number, lon: number, radiusMeters: number): boolean {
  const [south, west, north, east] = OSM_INDEX_BBOX;
  const box = circleBox(lat, lon, radiusMeters);
  return box.south >= south && box.north <= north && box.west >= west && box.east <= east;
}

/** Parses and validates an index document; throws on anything malformed. */
export function parseOsmIndex(json: string): OsmIndex {
  const doc = JSON.parse(json) as Partial<{
    version: number;
    osmTimestamp: string;
    builtAt: string;
    source: OsmIndex["source"];
    bbox: [number, number, number, number];
    elements: RawElement[];
  }>;
  if (
    doc.version !== 1 ||
    typeof doc.osmTimestamp !== "string" ||
    Number.isNaN(Date.parse(doc.osmTimestamp)) ||
    !doc.source?.url ||
    !Array.isArray(doc.bbox) ||
    !Array.isArray(doc.elements)
  ) {
    throw new Error("OSM index document is malformed.");
  }
  const grid = new Map<string, number[]>();
  doc.elements.forEach((element, i) => {
    const key = cellKey(element[2], element[3]);
    const cell = grid.get(key);
    if (cell) cell.push(i);
    else grid.set(key, [i]);
  });
  return {
    osmTimestamp: doc.osmTimestamp,
    builtAt: doc.builtAt ?? doc.osmTimestamp,
    source: doc.source,
    bbox: doc.bbox,
    elements: doc.elements,
    grid,
  };
}

async function download(signal?: AbortSignal): Promise<OsmIndex> {
  const url = process.env.OSM_INDEX_URL || DEFAULT_OSM_INDEX_URL;
  const timeout = AbortSignal.timeout(LOAD_TIMEOUT_MS);
  const res = await fetch(url, {
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    // Never let Next's data cache hold a multi-megabyte body.
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`OSM index download returned HTTP ${res.status}`);
  const body = Buffer.from(await res.arrayBuffer());
  return parseOsmIndex(zlib.gunzipSync(body).toString("utf8"));
}

/**
 * The current index, or null when it is disabled, unavailable, or too old.
 * A warm instance reuses its copy; concurrent callers share one download.
 */
export async function loadOsmIndex(signal?: AbortSignal): Promise<OsmIndex | null> {
  if (process.env.OSM_INDEX_DISABLED === "true") return null;
  const now = Date.now();
  let index: OsmIndex | null = null;
  if (loaded && now - loaded.at < RELOAD_AFTER_MS) {
    index = loaded.index;
  } else if (now - lastFailureAt >= RETRY_AFTER_FAILURE_MS) {
    inflight ??= download(signal)
      .then((fresh) => {
        loaded = { index: fresh, at: Date.now() };
        return fresh;
      })
      .catch((err: unknown) => {
        lastFailureAt = Date.now();
        logger.warn("OSM index unavailable; falling back to live Overpass", serializeError(err));
        // Keep serving the previous copy if there is one.
        return loaded?.index ?? null;
      })
      .finally(() => {
        inflight = null;
      });
    index = await inflight;
  } else {
    index = loaded?.index ?? null;
  }
  if (index && now - Date.parse(index.osmTimestamp) > OSM_INDEX_MAX_AGE_MS) {
    logger.warn("OSM index is too old to use; falling back to live Overpass", {
      osmTimestamp: index.osmTimestamp,
    });
    return null;
  }
  return index;
}

/**
 * Elements the equivalent Overpass query would return: named, matching any
 * of the tag pairs, within the radius. Nodes carry lat/lon; ways and
 * relations carry `center`, as with `out center`.
 */
export function queryOsmIndex(
  index: OsmIndex,
  tagPairs: OsmTagPair[],
  lat: number,
  lon: number,
  radiusMeters: number
): OverpassElement[] {
  const pairs = tagPairs.slice(0, MAX_TAG_CLAUSES);
  const box = circleBox(lat, lon, radiusMeters);
  const results: OverpassElement[] = [];
  for (
    let row = Math.floor(box.south / CELL_DEG);
    row <= Math.floor(box.north / CELL_DEG);
    row++
  ) {
    for (
      let col = Math.floor(box.west / CELL_DEG);
      col <= Math.floor(box.east / CELL_DEG);
      col++
    ) {
      for (const i of index.grid.get(`${row}:${col}`) ?? []) {
        const [type, id, eLat, eLon, tags] = index.elements[i];
        if (!tags.name) continue;
        if (!pairs.some(([key, value]) => tags[key] === value)) continue;
        if (haversineMeters(lat, lon, eLat, eLon) > radiusMeters) continue;
        results.push(
          type === "n"
            ? { type: TYPE_NAMES[type], id, lat: eLat, lon: eLon, tags }
            : { type: TYPE_NAMES[type], id, center: { lat: eLat, lon: eLon }, tags }
        );
      }
    }
  }
  return results;
}

/** Test hook: forget any loaded index and failure back-off. */
export function resetOsmIndexForTests(): void {
  loaded = null;
  inflight = null;
  lastFailureAt = 0;
}
