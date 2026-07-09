import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export type CacheBucket = "geocode" | "reports" | "homepages" | "robots";

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

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

function bucketDir(bucket: CacheBucket): string {
  return path.join(getCacheRoot(), bucket);
}

export async function readCache<T>(
  bucket: CacheBucket,
  key: string,
  maxAgeMs?: number
): Promise<T | null> {
  try {
    const file = path.join(bucketDir(bucket), `${hashKey(key)}.json`);
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as { savedAt: number; data: T };

    if (maxAgeMs !== undefined && Date.now() - parsed.savedAt > maxAgeMs) {
      return null;
    }

    return parsed.data;
  } catch {
    return null;
  }
}

export async function writeCache<T>(
  bucket: CacheBucket,
  key: string,
  data: T
): Promise<void> {
  try {
    const dir = bucketDir(bucket);
    await ensureDir(dir);
    const file = path.join(dir, `${hashKey(key)}.json`);
    await fs.writeFile(
      file,
      JSON.stringify({ savedAt: Date.now(), data }, null, 2),
      "utf8"
    );
  } catch {
    // Cache failures should never break the analysis pipeline.
  }
}

export async function writeNamedFile(
  bucket: CacheBucket,
  fileName: string,
  data: unknown
): Promise<void> {
  try {
    const dir = bucketDir(bucket);
    await ensureDir(dir);
    await fs.writeFile(
      path.join(dir, fileName),
      JSON.stringify(data, null, 2),
      "utf8"
    );
  } catch {
    // Non-fatal.
  }
}

export const CACHE_TTL = {
  geocode: 1000 * 60 * 60 * 24 * 7, // 7 days
  homepages: 1000 * 60 * 60 * 12, // 12 hours
  robots: 1000 * 60 * 60 * 24, // 24 hours
};
