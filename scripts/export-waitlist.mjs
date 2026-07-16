#!/usr/bin/env node
// Operator-only export for the hosted beta's waitlist.
//
// This is a plain Node script (no new dependencies) meant to be run by a
// human, from a machine that either has the production KV credentials or is
// pointed at a local dev store. It is NOT wired into any app route or public
// endpoint.
//
// It mirrors the exact key layout / value shape written by
// lib/store.ts#addWaitlistEmail, using the same env vars and the same
// filesystem fallback so it works identically to the app:
//
//   KV backend (Upstash/Vercel KV over REST, selected when
//   KV_REST_API_URL + KV_REST_API_TOKEN, or the UPSTASH_REDIS_REST_*
//   equivalents, are set):
//     - "waitlist:emails"  Redis SET of lowercase emails (membership only)
//     - "waitlist:entries" Redis LIST of JSON strings, one per signup event:
//         { email, at, source?, reportId? }
//       Note: the app RPUSHes an entry on every signup attempt, even repeat
//       ones for an email already on the list, so this list can contain more
//       rows than there are unique emails. This script dedupes by email,
//       keeping the earliest entry (i.e. the one that actually added them).
//
//   Filesystem fallback (local dev/CI, no KV env set), rooted at
//   `${CACHE_DIR ?? "./.cache"}/store/`:
//     - waitlist-emails.json    JSON array of lowercase emails
//     - waitlist-entries.jsonl  newline-delimited JSON, one signup per line
//       (the fs backend only appends here on the *first* signup for an
//       email, so it's already deduped, but we run it through the same
//       dedupe logic for consistency).
//
// Usage:
//   node scripts/export-waitlist.mjs [--format csv|json|both] [--out <path>]
//
// Examples:
//   node scripts/export-waitlist.mjs
//   node scripts/export-waitlist.mjs --format csv --out ./ops/waitlist
//
// Env (same as lib/store.ts):
//   KV_REST_API_URL / KV_REST_API_TOKEN
//   (or UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN)
// When neither pair is set, falls back to the filesystem store described
// above (CACHE_DIR, default ./.cache) -- handy for testing this script
// locally without touching production data.

import fs from "node:fs/promises";
import path from "node:path";

const FIXED_COLUMNS = ["email", "at", "source", "reportId"];

function usage() {
  return `Usage: node scripts/export-waitlist.mjs [--format csv|json|both] [--out <path>]

  --format csv|json|both   Which file(s) to write. Default: both.
  --out <path>             Output base path (extension added per format).
                            Default: ./waitlist-export
  -h, --help                Show this help.

Reads KV_REST_API_URL / KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_URL /
UPSTASH_REDIS_REST_TOKEN) to export from Upstash/Vercel KV. When neither
pair is set, falls back to the local filesystem store used by dev/CI
(CACHE_DIR, default ./.cache).
`;
}

function parseArgs(argv) {
  const args = { format: "both", out: "./waitlist-export" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "-h":
      case "--help":
        args.help = true;
        break;
      case "--format": {
        const value = argv[++i];
        if (!value) throw new Error("--format requires a value (csv|json|both)");
        args.format = value;
        break;
      }
      case "--out": {
        const value = argv[++i];
        if (!value) throw new Error("--out requires a path");
        args.out = value;
        break;
      }
      default:
        if (arg.startsWith("--format=")) {
          args.format = arg.slice("--format=".length);
        } else if (arg.startsWith("--out=")) {
          args.out = arg.slice("--out=".length);
        } else {
          throw new Error(`Unrecognized argument: ${arg}`);
        }
    }
  }
  return args;
}

function resolveFormats(formatArg) {
  const wanted = new Set(
    formatArg
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .flatMap((s) => (s === "both" ? ["csv", "json"] : [s]))
  );
  const invalid = [...wanted].filter((f) => f !== "csv" && f !== "json");
  if (invalid.length > 0) {
    throw new Error(
      `Invalid --format value(s): ${invalid.join(", ")}. Expected csv, json, or both.`
    );
  }
  return wanted;
}

function stripKnownExt(p) {
  return p.replace(/\.(csv|json)$/i, "");
}

// ---- lightweight .env loading (no dependency) ------------------------------
// Next.js dev/build load .env.local automatically; a plain `node` invocation
// of this script does not. To make local testing (and real KV exports, if an
// operator keeps creds in .env.local) painless, we opportunistically read
// .env.local then .env from the cwd and fill in any vars not already set in
// the environment. This is a minimal parser: KEY=VALUE per line, optional
// quotes, `#` comments, blank lines skipped. No multiline/expansion support.
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

// Detects a half-configured KV setup (one var set, its pair missing), which
// is almost certainly a mistake rather than an intentional fallback.
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

async function fetchEntriesFromKv(cfg) {
  const result = await kvCommand(cfg, ["LRANGE", "waitlist:entries", 0, -1]);
  return Array.isArray(result) ? result : [];
}

// ---- filesystem fallback ----------------------------------------------------

function storeRoot() {
  const base = process.env.CACHE_DIR
    ? path.resolve(process.cwd(), process.env.CACHE_DIR)
    : path.resolve(process.cwd(), ".cache");
  return path.join(base, "store");
}

async function fetchEntriesFromFs() {
  const file = path.join(storeRoot(), "waitlist-entries.jsonl");
  let raw;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    throw new Error(
      `Could not read local waitlist store at ${file}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  return raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
}

// ---- shared parsing / dedupe ------------------------------------------------

function parseEntries(rawLines) {
  const parsed = [];
  let skipped = 0;
  for (const line of rawLines) {
    try {
      const entry = JSON.parse(line);
      if (entry && typeof entry.email === "string") {
        parsed.push(entry);
      } else {
        skipped++;
      }
    } catch {
      skipped++;
    }
  }
  if (skipped > 0) {
    process.stderr.write(
      `Warning: skipped ${skipped} malformed waitlist entr${skipped === 1 ? "y" : "ies"}.\n`
    );
  }
  return parsed;
}

// Dedupe by lowercased email, keeping the earliest occurrence (list/append
// order is chronological), matching what the "emails" set actually tracks.
function dedupeByEmail(entries) {
  const seen = new Map();
  for (const entry of entries) {
    const key = entry.email.toLowerCase();
    if (!seen.has(key)) seen.set(key, entry);
  }
  return [...seen.values()];
}

function extraColumns(entries) {
  const extras = new Set();
  for (const entry of entries) {
    for (const key of Object.keys(entry)) {
      if (!FIXED_COLUMNS.includes(key)) extras.add(key);
    }
  }
  return [...extras].sort();
}

function csvEscape(value) {
  const s = value === undefined || value === null ? "" : String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function toCsv(entries, columns) {
  const lines = [columns.map(csvEscape).join(",")];
  for (const entry of entries) {
    lines.push(columns.map((col) => csvEscape(entry[col])).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

function toJson(entries, columns) {
  const reordered = entries.map((entry) => {
    const out = {};
    for (const col of columns) {
      if (entry[col] !== undefined) out[col] = entry[col];
    }
    return out;
  });
  return JSON.stringify(reordered, null, 2) + "\n";
}

// ---- main -------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    return;
  }

  const formats = resolveFormats(args.format);

  await loadDotEnvFallback();

  if (kvConfigIsPartial()) {
    throw new Error(
      "Incomplete KV credentials: set both KV_REST_API_URL and KV_REST_API_TOKEN " +
        "(or both UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN), or unset " +
        "both to fall back to the local filesystem store."
    );
  }

  const cfg = kvConfig();
  let rawLines;
  let backendDescription;
  if (cfg) {
    rawLines = await fetchEntriesFromKv(cfg);
    backendDescription = `Upstash/Vercel KV (${cfg.url})`;
  } else {
    rawLines = await fetchEntriesFromFs();
    backendDescription = `local filesystem fallback (${storeRoot()})`;
  }

  const parsedEntries = parseEntries(rawLines);
  const uniqueEntries = dedupeByEmail(parsedEntries);

  if (uniqueEntries.length === 0) {
    throw new Error(
      `Waitlist is empty: no signups found in ${backendDescription}.`
    );
  }

  const columns = [...FIXED_COLUMNS, ...extraColumns(uniqueEntries)];
  const outBase = stripKnownExt(args.out);

  const written = [];
  if (formats.has("csv")) {
    const csvPath = path.resolve(process.cwd(), `${outBase}.csv`);
    await fs.mkdir(path.dirname(csvPath), { recursive: true });
    await fs.writeFile(csvPath, toCsv(uniqueEntries, columns), "utf8");
    written.push(csvPath);
  }
  if (formats.has("json")) {
    const jsonPath = path.resolve(process.cwd(), `${outBase}.json`);
    await fs.mkdir(path.dirname(jsonPath), { recursive: true });
    await fs.writeFile(jsonPath, toJson(uniqueEntries, columns), "utf8");
    written.push(jsonPath);
  }

  const duplicateEvents = parsedEntries.length - uniqueEntries.length;
  process.stdout.write(
    `Exported ${uniqueEntries.length} unique waitlist signup(s) from ${backendDescription}` +
      (duplicateEvents > 0
        ? ` (${duplicateEvents} duplicate signup event(s) collapsed).\n`
        : ".\n")
  );
  for (const file of written) {
    process.stdout.write(`  wrote ${file}\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`export-waitlist: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
