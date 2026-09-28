#!/usr/bin/env node
// Builds the Bay Area OpenStreetMap business index from an osmium geojsonseq
// export. Run by .github/workflows/osm-index.yml; see DEPLOY.md.
//
// Usage:
//   node scripts/build-osm-index.mjs --input poi.geojsonseq \
//     --timestamp 2026-09-27T20:21:02Z --out bayarea-pois.json.gz \
//     [--min-count 20000]

import fs from "node:fs";
import readline from "node:readline";
import zlib from "node:zlib";
import { createIndexBuilder } from "./build-osm-index-lib.mjs";

export const BAY_AREA_BBOX = [36.85, -123.15, 38.65, -121.2];

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : fallback;
}

const input = arg("input");
const out = arg("out", "bayarea-pois.json.gz");
const osmTimestamp = arg("timestamp");
const minCount = Number(arg("min-count", "0"));

if (!input || !osmTimestamp || Number.isNaN(Date.parse(osmTimestamp))) {
  console.error("Usage: --input <geojsonseq> --timestamp <ISO date> [--out file] [--min-count n]");
  process.exit(2);
}

const lines = readline.createInterface({
  input: fs.createReadStream(input, "utf8"),
  crlfDelay: Infinity,
});
const builder = createIndexBuilder(BAY_AREA_BBOX);
for await (const line of lines) builder.add(line);

const { index, rejected } = builder.finish({
  osmTimestamp: new Date(osmTimestamp).toISOString(),
  builtAt: new Date().toISOString(),
  source: {
    name: "OpenStreetMap contributors, via the Geofabrik Northern California extract",
    url: "https://download.geofabrik.de/north-america/us/california/norcal.html",
    license: "ODbL 1.0 (https://www.openstreetmap.org/copyright)",
  },
});

if (index.count < minCount) {
  console.error(`Only ${index.count} elements (minimum ${minCount}); refusing to publish.`);
  process.exit(1);
}

const json = JSON.stringify(index);
const gz = zlib.gzipSync(json, { level: 9 });
fs.writeFileSync(out, gz);
console.log(
  `Wrote ${out}: ${index.count} elements, ${rejected} rejected, ` +
    `${(json.length / 1e6).toFixed(1)} MB raw, ${(gz.length / 1e6).toFixed(2)} MB gzip, ` +
    `OSM data as of ${index.osmTimestamp}.`
);
