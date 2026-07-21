#!/usr/bin/env node
// Operator-only report counter for the hosted beta.
//
// This is a plain Node script (no new dependencies) meant to be run by a
// human, from a machine that either has the production KV credentials or is
// pointed at a local dev store. It is NOT wired into any app route or public
// endpoint. It is read-only: it never writes to the store.
//
// WHY THIS EXISTS
// ----------------
// Reports have no index. Unlike the waitlist (a Redis SET + LIST), each report
// is written by lib/store.ts#saveReport as a *standalone* key
//   report:v2:<id>   (SET ... EX 90 days)
// with a 90-day TTL and nothing enumerating them. So the only way to count
// them is to SCAN the keyspace (KV) or list the fallback directory (fs).
//
// TWO NUMBERS, DELIBERATELY SEPARATE
// ----------------------------------
// The Day-14 campaign card asks for "NN local businesses scouted", but a single
// report scouts a *whole market* of many businesses. Those are different units,
// off by ~10x, so this script reports both and never conflates them:
//
//   reports run       = number of report:v2:* keys (one per analysis run).
//                       This is the unambiguous, non-duplicable unit.
//   businesses scouted = sum of summary.competitorCount across those reports
//                       (the real competitors each run pulled from OSM/Overpass
//                       and audited). This counts scouting instances, NOT
//                       distinct businesses: the same shop scouted in two runs
//                       counts twice. Do not present it as distinct-business
//                       coverage.
//
// IMPORTANT — the 90-day TTL means both numbers are "in the last 90 days", not
// all-time. Reports created earlier have already expired out of the store and
// cannot be counted. For a launch that is only weeks old this is effectively
// all-time, but it stops being true after 90 days.
//
// LEGACY KEYS
// -----------
// Pre-v2 runs were written as report:<id> (no v2: segment). The app treats
// these as unreadable ("legacy") and they use an older, unvalidated schema, so
// they are NOT folded into "reports run" or the businesses sum. They are
// counted and reported separately so nothing real is hidden; include them in a
// public number only if you have a reason to.
//
// Usage:
//   node scripts/count-reports.mjs [--reports-only] [--json]
//
// Examples:
//   node scripts/count-reports.mjs
//   node scripts/count-reports.mjs --reports-only
//   node scripts/count-reports.mjs --json
//
// Env (same as lib/store.ts):
//   KV_REST_API_URL / KV_REST_API_TOKEN
//   (or UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN)
// When neither pair is set, falls back to the filesystem store used by dev/CI
// (CACHE_DIR, default ./.cache) -- handy for testing this script locally
// without touching production data.

import fs from "node:fs/promises";
import path from "node:path";
import {
  competitorCountFromRaw,
  partitionReportKeys,
} from "./count-reports-lib.mjs";

const LEGACY_PATTERN_PREFIX = "report:"; // matches both v2 and legacy; SCAN once
const MGET_BATCH = 64;

function usage() {
  return `Usage: node scripts/count-reports.mjs [--reports-only] [--json]

  --reports-only   Count keys only; skip fetching report bodies to sum
                   businesses scouted. Faster, and the only field needed if you
                   are wording Day 14 as reports/markets run.
  --json           Emit a machine-readable JSON object instead of prose.
  -h, --help       Show this help.

Reads KV_REST_API_URL / KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_URL /
UPSTASH_REDIS_REST_TOKEN) to count from Upstash/Vercel KV. When neither pair is
set, falls back to the local filesystem store used by dev/CI (CACHE_DIR,
default ./.cache).
`;
}

function parseArgs(argv) {
  const args = { reportsOnly: false, json: false };
  for (const arg of argv) {
    switch (arg) {
      case "-h":
      case "--help":
        args.help = true;
        break;
      case "--reports-only":
        args.reportsOnly = true;
        break;
      case "--json":
        args.json = true;
        break;
      default:
        throw new Error(`Unrecognized argument: ${arg}`);
    }
  }
  return args;
}

// ---- lightweight .env loading (no dependency) ------------------------------
// Mirrors scripts/export-waitlist.mjs: a plain `node` invocation does not load
// .env.local the way Next.js dev/build does, so we opportunistically read
// .env.local then .env from the cwd and fill in any vars not already set.
// Minimal parser: KEY=VALUE per line, optional quotes, `#` comments, blanks
// skipped. No multiline/expansion.
async function loadDotEnvFallback() {
  for (const file of [".env.local", ".env"]) {
    try {
      const raw = await fs.readFile(path.resolve(process.cwd(), file), "utf8");
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim();
        let value = trimmed.slice(eq + 1).trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        if (process.env[key] === undefined) process.env[key] = value;
      }
    } catch {
      // File absent or unreadable -- fine, this is best-effort.
    }
  }
}

// ---- KV backend -------------------------------------------------------------

function kvConfig() {
  const url =
    process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL ?? "";
  const token =
    process.env.KV_REST_API_TOKEN ??
    process.env.UPSTASH_REDIS_REST_TOKEN ??
    "";
  if (url && token) return { url: url.replace(/\/$/, ""), token };
  return null;
}

// Detects a half-configured KV setup (one var set, its pair missing), which is
// almost certainly a mistake rather than an intentional fallback.
function kvConfigIsPartial() {
  const url =
    process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL ?? "";
  const token =
    process.env.KV_REST_API_TOKEN ??
    process.env.UPSTASH_REDIS_REST_TOKEN ??
    "";
  return Boolean(url) !== Boolean(token);
}

async function kvCommand(cfg, command) {
  let res;
  try {
    res = await fetch(cfg.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(command),
      cache: "no-store",
    });
  } catch (err) {
    throw new Error(
      `Could not reach KV REST API at ${cfg.url}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!res.ok) {
    throw new Error(
      `KV command failed with HTTP ${res.status} (${res.statusText}). Check that KV_REST_API_URL / KV_REST_API_TOKEN are correct.`
    );
  }
  const json = await res.json();
  if (json.error) throw new Error(`KV error: ${json.error}`);
  return json.result ?? null;
}

// Enumerate every key matching a glob via non-blocking SCAN. Upstash returns
// [nextCursor, [keys...]] per page; loop until the cursor comes back "0".
// De-dupes because SCAN can legitimately return the same key on multiple pages.
async function kvScanKeys(cfg, match) {
  const keys = new Set();
  let cursor = "0";
  do {
    const page = await kvCommand(cfg, [
      "SCAN",
      cursor,
      "MATCH",
      match,
      "COUNT",
      1000,
    ]);
    if (!Array.isArray(page) || page.length < 2) {
      throw new Error("Unexpected SCAN response shape from KV.");
    }
    cursor = String(page[0]);
    const batch = Array.isArray(page[1]) ? page[1] : [];
    for (const key of batch) keys.add(key);
  } while (cursor !== "0");
  return [...keys];
}

async function collectFromKv(cfg, reportsOnly) {
  // One SCAN over report:* covers both schemas; partition in memory so we make
  // a single pass of the keyspace rather than two.
  const allKeys = await kvScanKeys(cfg, `${LEGACY_PATTERN_PREFIX}*`);
  const { v2: v2Keys, legacy: legacyKeys } = partitionReportKeys(allKeys);

  let businesses = null;
  let unreadable = 0;
  if (!reportsOnly && v2Keys.length > 0) {
    businesses = 0;
    for (let i = 0; i < v2Keys.length; i += MGET_BATCH) {
      const batch = v2Keys.slice(i, i + MGET_BATCH);
      const values = await kvCommand(cfg, ["MGET", ...batch]);
      for (const raw of Array.isArray(values) ? values : []) {
        const n = competitorCountFromRaw(raw);
        if (n === null) unreadable++;
        else businesses += n;
      }
    }
  }

  return {
    backend: `Upstash/Vercel KV (${cfg.url})`,
    reportsRun: v2Keys.length,
    legacyReports: legacyKeys.length,
    businesses,
    unreadable,
  };
}

// ---- filesystem fallback ----------------------------------------------------

function storeRoot() {
  const base = process.env.CACHE_DIR
    ? path.resolve(process.cwd(), process.env.CACHE_DIR)
    : path.resolve(process.cwd(), ".cache");
  return path.join(base, "store");
}

async function listJsonFiles(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    throw new Error(
      `Could not read local store dir ${dir}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .map((e) => path.join(dir, e.name));
}

async function collectFromFs(reportsOnly) {
  const root = storeRoot();
  const v2Files = await listJsonFiles(path.join(root, "report-v2"));
  const legacyFiles = await listJsonFiles(path.join(root, "reports"));

  let businesses = null;
  let unreadable = 0;
  if (!reportsOnly && v2Files.length > 0) {
    businesses = 0;
    for (const file of v2Files) {
      let raw;
      try {
        raw = await fs.readFile(file, "utf8");
      } catch {
        unreadable++;
        continue;
      }
      const n = competitorCountFromRaw(raw);
      if (n === null) unreadable++;
      else businesses += n;
    }
  }

  return {
    backend: `local filesystem fallback (${root})`,
    reportsRun: v2Files.length,
    legacyReports: legacyFiles.length,
    businesses,
    unreadable,
  };
}

// ---- main -------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    return;
  }

  await loadDotEnvFallback();

  if (kvConfigIsPartial()) {
    throw new Error(
      "Incomplete KV credentials: set both KV_REST_API_URL and KV_REST_API_TOKEN " +
        "(or both UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN), or unset " +
        "both to fall back to the local filesystem store."
    );
  }

  const cfg = kvConfig();
  const result = cfg
    ? await collectFromKv(cfg, args.reportsOnly)
    : await collectFromFs(args.reportsOnly);

  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }

  const lines = [];
  lines.push(`Backend: ${result.backend}`);
  lines.push(`Window:  reports created in the last 90 days (TTL); older runs have expired out.`);
  lines.push("");
  lines.push(`Reports run (v2):     ${result.reportsRun}`);
  if (result.businesses !== null) {
    lines.push(
      `Businesses scouted:   ${result.businesses}  ` +
        `(sum of competitors audited across those reports; counts repeat scouts, not distinct businesses)`
    );
  } else if (!args.reportsOnly) {
    lines.push(`Businesses scouted:   n/a (no v2 reports to sum)`);
  }
  if (result.unreadable > 0) {
    lines.push(
      `Unreadable v2 reports: ${result.unreadable}  (excluded from the businesses sum)`
    );
  }
  if (result.legacyReports > 0) {
    lines.push(
      `Legacy reports:       ${result.legacyReports}  ` +
        `(pre-v2 schema, not counted above; include publicly only with a reason)`
    );
  }
  process.stdout.write(lines.join("\n") + "\n");
}

main().catch((err) => {
  process.stderr.write(
    `count-reports: ${err instanceof Error ? err.message : String(err)}\n`
  );
  process.exitCode = 1;
});
