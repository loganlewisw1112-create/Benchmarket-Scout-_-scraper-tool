// Turns an `osmium export -f geojsonseq --add-unique-id=type_id` stream of
// OpenStreetMap features into the compact Bay Area business index that
// lib/osm-index.ts serves competitor discovery from.
//
// Every element keeps its real OSM type, id, and tags, and is placed at the
// same point Overpass reports for `out center`: nodes at their coordinates,
// ways and relations at the center of their bounding box. Nothing is
// inferred or filled in.

// Keys that decide whether an element is a business at all. Mirrors the
// category keys lib/overpass.ts resolves industries to.
export const CATEGORY_KEYS = [
  "amenity",
  "craft",
  "healthcare",
  "leisure",
  "office",
  "shop",
  "sport",
  "tourism",
];

// Tags that never feed discovery, scoring, or display. Dropping them keeps the
// index small; everything else is kept verbatim.
const DROPPED_TAG = new RegExp(
  "^(" +
    [
      "name:",
      "alt_name",
      "old_name",
      "official_name:",
      "short_name:",
      "source",
      "note",
      "fixme",
      "FIXME",
      "description",
      "image",
      "mapillary",
      "check_date",
      "survey",
      "created_by",
      "tiger:",
      "gnis:",
      "wikimedia_commons",
      "payment:",
      "diet:",
      "fuel:",
      "currency:",
      "opening_hours:",
      "building",
      "roof:",
      "height",
      "level",
      "ref:",
      "not:",
      "was:",
      "disused:",
    ].join("|") +
    ")"
);

export function parseElementId(rawId) {
  const text = String(rawId ?? "");
  const direct = /^([nwr])(\d+)$/.exec(text);
  if (direct) return { type: direct[1], id: Number(direct[2]) };
  // osmium area ids: 2*way_id for closed ways, 2*relation_id+1 for relations.
  const area = /^a(\d+)$/.exec(text);
  if (area) {
    const n = Number(area[1]);
    return n % 2 === 0 ? { type: "w", id: n / 2 } : { type: "r", id: (n - 1) / 2 };
  }
  return null;
}

function eachPosition(coords, visit) {
  if (typeof coords[0] === "number") {
    visit(coords[0], coords[1]);
    return;
  }
  for (const part of coords) eachPosition(part, visit);
}

/** Overpass `out center`: a point's own position, else its bbox center. */
export function centerOf(geometry) {
  if (!geometry || !geometry.coordinates) return null;
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  eachPosition(geometry.coordinates, (lon, lat) => {
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  });
  if (!Number.isFinite(minLon) || !Number.isFinite(minLat)) return null;
  return { lat: (minLat + maxLat) / 2, lon: (minLon + maxLon) / 2 };
}

export function keepTags(properties) {
  const tags = {};
  for (const [key, value] of Object.entries(properties ?? {})) {
    if (key.startsWith("@") || typeof value !== "string") continue;
    if (DROPPED_TAG.test(key)) continue;
    tags[key] = value;
  }
  return tags;
}

const round5 = (n) => Math.round(n * 1e5) / 1e5;

/**
 * One GeoJSON feature -> [type, id, lat, lon, tags], or null when it is not a
 * named business inside the bbox.
 */
export function toIndexElement(feature, bbox) {
  const props = feature?.properties ?? {};
  const name = typeof props.name === "string" ? props.name.trim() : "";
  if (!name) return null;
  if (!CATEGORY_KEYS.some((key) => typeof props[key] === "string")) return null;
  const parsed = parseElementId(feature.id ?? props["@id"]);
  if (!parsed) return null;
  const center = centerOf(feature.geometry);
  if (!center) return null;
  const [south, west, north, east] = bbox;
  if (
    center.lat < south ||
    center.lat > north ||
    center.lon < west ||
    center.lon > east
  ) {
    return null;
  }
  return [parsed.type, parsed.id, round5(center.lat), round5(center.lon), keepTags(props)];
}

/**
 * Streaming builder: feed geojsonseq lines one at a time with add(), then
 * finish() returns the index document. Only kept elements stay in memory.
 */
export function createIndexBuilder(bbox) {
  const seen = new Set();
  const elements = [];
  let rejected = 0;
  return {
    add(rawLine) {
      // geojsonseq records may start with the RS (0x1e) separator.
      const line = rawLine.replace(/^\u001e/, "").trim();
      if (!line) return;
      let feature;
      try {
        feature = JSON.parse(line);
      } catch {
        rejected += 1;
        return;
      }
      const element = toIndexElement(feature, bbox);
      if (!element) {
        rejected += 1;
        return;
      }
      const key = `${element[0]}${element[1]}`;
      if (seen.has(key)) return;
      seen.add(key);
      elements.push(element);
    },
    finish({ osmTimestamp, builtAt, source }) {
      elements.sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] < b[0] ? -1 : 1));
      return {
        index: {
          version: 1,
          region: "bayarea",
          source,
          osmTimestamp,
          builtAt,
          bbox,
          count: elements.length,
          elements,
        },
        rejected,
      };
    },
  };
}

/** Convenience wrapper over createIndexBuilder for an in-memory list. */
export function buildIndex(lines, { bbox, osmTimestamp, builtAt, source }) {
  const builder = createIndexBuilder(bbox);
  for (const line of lines) builder.add(line);
  return builder.finish({ osmTimestamp, builtAt, source });
}
