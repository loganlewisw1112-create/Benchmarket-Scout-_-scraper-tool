import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { assertRealDataResponse } from "./invariants";
import { logger, serializeError } from "./logger";
import { kvCommand, kvConfig, type KvConfig } from "./store";
import type { AnalyzeMarketResponse } from "./types";

// Two backends behind one API, chosen per call:
//   - KV (the Upstash store in lib/store.ts, including its preview guard) for
//     the durable buckets whenever it is configured. Entries live under
//     "cache:v1:<bucket>:<sha256>" and expire with the bucket's retention, so
//     another instance or a cold start still gets the hit.
//   - Otherwise one JSON file per entry under CACHE_DIR. On Vercel that is
//     /tmp: per-instance and wiped on a cold start, so best-effort only.
// Homepage audits never go to KV; they stay per-instance (DEPLOY.md).
// Reads and writes fail open: a cache problem means a live fetch, never a
// failed request. Durable state (reports, samples, rate limits) lives in
// lib/store.ts.
export type CacheBucket =
  | "geocode"
  | "reports"
  | "homepages"
  | "robots"
  | "overpass";

export const CACHE_TTL = {
  // A market's coordinates and bounding box barely move; the cached result
  // keeps its original accessedAt for the Sources Appendix.
  geocode: 1000 * 60 * 60 * 24 * 30, // 30 days
  // Full analysis responses. Short, because a business that changes its site
  // should see the change; a hit keeps its original generatedAt and is
  // flagged dataQuality.cacheHit, so it is never presented as newly generated.
  reports: 1000 * 60 * 60 * 6, // 6 hours
  homepages: 1000 * 60 * 60 * 12, // 12 hours
  robots: 1000 * 60 * 60 * 24, // 24 hours
  // Overpass discovery results younger than this are used without a live
  // query (lib/overpass.ts).
  overpass: 1000 * 60 * 60 * 72, // 72 hours
  // Older ones are kept this long and used only when every live Overpass
  // mirror fails (stale-if-error), with the original retrieval date disclosed.
  overpassStaleIfError: 1000 * 60 * 60 * 24 * 14, // 14 days
};

// How long an entry is kept at all: its KV expiry, and the oldest entry the
// file backend returns. Only Overpass keeps entries past its fresh window.
function retentionMs(bucket: CacheBucket): number {
  return bucket === "overpass" ? CACHE_TTL.overpassStaleIfError : CACHE_TTL[bucket];
}

const DURABLE_BUCKETS: ReadonlySet<CacheBucket> = new Set([
  "geocode",
  "reports",
  "robots",
  "overpass",
]);

// Upstash rejects requests over 1 MB, and the value travels JSON-escaped
// inside the command body. Larger entries are simply not cached in KV.
export const MAX_DURABLE_CACHE_VALUE_BYTES = 512 * 1024;

export type CacheEntry<T> = { data: T; savedAt: number };

// Resolved lazily (not at module scope) so Next's file tracer does not treat
// the dynamic env-driven path as a signal to trace the whole project.
function getCacheRoot(): string {
  return process.env.CACHE_DIR
    ? path.resolve(/* turbopackIgnore: true */ process.cwd(), process.env.CACHE_DIR)
    : path.resolve(process.cwd(), ".cache");
}

function hashKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}

function versionedKey(bucket: CacheBucket, key: string): string {
  return bucket === "reports" ? `report:v2:${key}` : key;
}

/** KV key for a cache entry: namespaced by bucket, hashed like the file name. */
export function durableCacheKey(bucket: CacheBucket, key: string): string {
  return `cache:v1:${bucket}:${hashKey(versionedKey(bucket, key))}`;
}

function durableStore(bucket: CacheBucket): KvConfig | null {
  if (!DURABLE_BUCKETS.has(bucket)) return null;
  try {
    return kvConfig();
  } catch {
    return null;
  }
}

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

function bucketDir(bucket: CacheBucket): string {
  return path.join(getCacheRoot(), bucket);
}

function entryFile(bucket: CacheBucket, key: string): string {
  return path.join(bucketDir(bucket), `${hashKey(versionedKey(bucket, key))}.json`);
}

/**
 * The stored entry with its write time, or null on a miss, an entry past the
 * bucket's retention, a corrupt entry, or any backend error. Callers that
 * distinguish fresh from stale (Overpass) judge the age themselves.
 */
export async function readCacheEntry<T>(
  bucket: CacheBucket,
  key: string
): Promise<CacheEntry<T> | null> {
  const cfg = durableStore(bucket);
  let raw: string | null;
  try {
    raw = cfg
      ? ((await kvCommand(cfg, ["GET", durableCacheKey(bucket, key)])) as string | null)
      : await fs.readFile(entryFile(bucket, key), "utf8");
  } catch (error) {
    // A file miss is the normal case; a KV failure is worth a warning.
    if (cfg) {
      logger.warn("Cache read failed; continuing without it", {
        bucket,
        ...serializeError(error),
      });
    }
    return null;
  }
  if (typeof raw !== "string" || !raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<CacheEntry<T>>;
    if (
      typeof parsed.savedAt !== "number" ||
      !Number.isFinite(parsed.savedAt) ||
      !Object.hasOwn(parsed, "data")
    ) {
      return null;
    }
    if (Date.now() - parsed.savedAt > retentionMs(bucket)) return null;
    if (bucket === "reports") {
      assertRealDataResponse(parsed.data as AnalyzeMarketResponse);
    }
    return { data: parsed.data as T, savedAt: parsed.savedAt };
  } catch {
    return null;
  }
}

export async function readCache<T>(
  bucket: CacheBucket,
  key: string,
  maxAgeMs?: number
): Promise<T | null> {
  const entry = await readCacheEntry<T>(bucket, key);
  if (!entry) return null;
  if (maxAgeMs !== undefined && Date.now() - entry.savedAt > maxAgeMs) {
    return null;
  }
  return entry.data;
}

export async function writeCache<T>(
  bucket: CacheBucket,
  key: string,
  data: T
): Promise<void> {
  if (bucket === "reports") {
    assertRealDataResponse(data as AnalyzeMarketResponse);
  }
  const envelope = { savedAt: Date.now(), data };
  const cfg = durableStore(bucket);
  if (cfg) {
    try {
      const payload = JSON.stringify(envelope);
      const bytes = Buffer.byteLength(payload, "utf8");
      if (bytes > MAX_DURABLE_CACHE_VALUE_BYTES) {
        logger.warn("Cache entry too large for KV; not cached", { bucket, bytes });
        return;
      }
      await kvCommand(cfg, [
        "SET",
        durableCacheKey(bucket, key),
        payload,
        "EX",
        Math.ceil(retentionMs(bucket) / 1000),
      ]);
    } catch (error) {
      // Cache failures should never break the analysis pipeline.
      logger.warn("Cache write failed; continuing without it", {
        bucket,
        ...serializeError(error),
      });
    }
    return;
  }
  try {
    const dir = bucketDir(bucket);
    await ensureDir(dir);
    await fs.writeFile(
      entryFile(bucket, key),
      JSON.stringify(envelope, null, 2),
      "utf8"
    );
  } catch {
    // Cache failures should never break the analysis pipeline.
  }
}

// Used by the forced sample refresh. Unlike reads and writes, a failed delete
// throws: a refresh that silently served the cached analysis would not be one.
export async function deleteCache(
  bucket: CacheBucket,
  key: string
): Promise<void> {
  const cfg = durableStore(bucket);
  if (cfg) {
    await kvCommand(cfg, ["DEL", durableCacheKey(bucket, key)]);
    return;
  }
  try {
    await fs.unlink(entryFile(bucket, key));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function writeNamedFile(
  bucket: CacheBucket,
  fileName: string,
  data: unknown
): Promise<void> {
  if (bucket === "reports") {
    assertRealDataResponse(data as AnalyzeMarketResponse);
  }
  try {
    const dir = bucketDir(bucket);
    await ensureDir(dir);
    await fs.writeFile(
      path.join(dir, bucket === "reports" ? `report-v2-${fileName}` : fileName),
      JSON.stringify(data, null, 2),
      "utf8"
    );
  } catch {
    // Non-fatal.
  }
}
