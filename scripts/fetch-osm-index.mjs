#!/usr/bin/env node
// Build step: download the published Bay Area OSM index into
// data/osm-index/ so it ships inside the server bundle (see
// outputFileTracingIncludes in next.config.ts). Analyses then read it from
// disk instead of downloading 5 MB on a cold start. Never fails the build:
// without a bundled copy, lib/osm-index.ts downloads the index at runtime,
// and without that, discovery falls back to live Overpass.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const DEFAULT_URL =
  "https://github.com/loganlewisw1112-create/Benchmarket-Scout-_-scraper-tool/releases/download/osm-index-bayarea/bayarea-pois.json.gz";
const url = process.env.OSM_INDEX_URL || DEFAULT_URL;
const target = path.join(process.cwd(), "data", "osm-index", "bayarea-pois.json.gz");

if (process.env.OSM_INDEX_DISABLED === "true" || process.env.SKIP_OSM_INDEX_FETCH === "true") {
  console.log("OSM index fetch skipped.");
  process.exit(0);
}

try {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = Buffer.from(await res.arrayBuffer());
  const doc = JSON.parse(zlib.gunzipSync(body).toString("utf8"));
  if (doc.version !== 1 || !Array.isArray(doc.elements) || doc.elements.length === 0) {
    throw new Error("downloaded index is malformed");
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body);
  console.log(
    `Bundled OSM index: ${doc.elements.length} elements, OSM data as of ${doc.osmTimestamp}.`
  );
} catch (err) {
  console.warn(
    `OSM index not bundled (${err instanceof Error ? err.message : String(err)}); ` +
      "the app will download it at runtime or fall back to live Overpass."
  );
}
