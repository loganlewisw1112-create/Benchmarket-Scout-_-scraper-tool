// Durable key/value store for the hosted deployment.
//
// Two interchangeable backends, selected at runtime:
//   - Upstash/Vercel KV over its REST API (no SDK dependency, just fetch),
//     used automatically when KV_REST_API_URL + KV_REST_API_TOKEN (or the
//     UPSTASH_REDIS_REST_* equivalents) are present. This is what runs in
//     production on Vercel, where the filesystem is read-only/ephemeral.
//   - A flat-file fallback under CACHE_DIR (same convention as lib/cache.ts)
//     used for local dev, tests, and CI so nothing external is required.
//
// Everything here is best-effort at the call site: callers wrap writes so a
// store hiccup never breaks the core analysis pipeline.

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { assertRealDataResponse } from "./invariants";
import { logger } from "./logger";
import {
  checkFixedWindowRateLimit,
  inspectFixedWindowRateLimit,
  WINDOW_MS,
} from "./rate-limit";
import type { AnalyzeMarketResponse } from "./types";

const REPORT_TTL_SECONDS = 60 * 60 * 24 * 90; // 90 days
// Shorter than the report TTL so a served sample's /r/<reportId> link never
// outlives the report it points at.
export const SAMPLE_SNAPSHOT_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
// Sliding: every admission re-arms it, so the waitlist keys expire 365 days
// after the most recent signup event.
export const WAITLIST_TTL_SECONDS = 60 * 60 * 24 * 365; // 365 days
const ID_PATTERN = /^[A-Za-z0-9_-]{6,64}$/;
export const KV_REQUEST_TIMEOUT_MS = 1_500;

export type StoredReport = {
  schemaVersion: 2;
  id: string;
  createdAt: string;
  report: AnalyzeMarketResponse;
};

export type ReportReadOutcome =
  | { status: "ok"; value: StoredReport }
  | { status: "legacy" }
  | { status: "missing" }
  | { status: "invalid" };

export type SampleSnapshotV2 = {
  schemaVersion: 2;
  sampleId: string;
  catalogId: string;
  reportId: string;
  generatedAt: string;
  report: AnalyzeMarketResponse;
};

export type SampleReadOutcome =
  | { status: "ok"; value: SampleSnapshotV2 }
  | { status: "legacy" }
  | { status: "missing" }
  | { status: "invalid" };

export type CatalogSampleRead = {
  catalogId: string;
  outcome: SampleReadOutcome;
};

// Tiny per-catalog record written beside each snapshot so health can inspect
// the pool without reading ~55 KB report bodies.
export type SampleSnapshotMeta = {
  schemaVersion: 2;
  catalogId: string;
  sampleId: string;
  reportId: string;
  generatedAt: string;
};

export type SampleMetaReadOutcome =
  | { status: "ok"; value: SampleSnapshotMeta }
  | { status: "missing" }
  | { status: "invalid" };

export type CatalogSampleMetaRead = {
  catalogId: string;
  outcome: SampleMetaReadOutcome;
};

export type WaitlistOutcome = "added" | "exists";

export type WaitlistAdmission =
  | { outcome: WaitlistOutcome }
  | { outcome: "rate_limited"; retryAfterMs: number };

export const WAITLIST_NEW_SIGNUPS_PER_WINDOW = 10;

const WAITLIST_GLOBAL_LIMIT_KEY = "global:waitlist:new-signups";
const WAITLIST_EMAILS_KEY = "waitlist:emails";
const WAITLIST_ENTRIES_KEY = "waitlist:entries";

const WAITLIST_ADMISSION_SCRIPT = `
local email_exists = redis.call('SISMEMBER', KEYS[1], ARGV[1])
if email_exists == 1 then
  redis.call('RPUSH', KEYS[2], ARGV[2])
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[5]))
  redis.call('EXPIRE', KEYS[2], tonumber(ARGV[5]))
  return {0, 0}
end

local current = tonumber(redis.call('GET', KEYS[3]) or '0')
local maximum = tonumber(ARGV[3])
if current >= maximum then
  return {2, current}
end

current = redis.call('INCR', KEYS[3])
if current == 1 then
  redis.call('PEXPIRE', KEYS[3], tonumber(ARGV[4]))
end
redis.call('SADD', KEYS[1], ARGV[1])
redis.call('RPUSH', KEYS[2], ARGV[2])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[5]))
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[5]))
return {1, current}
`;

const CAPPED_RATE_LIMIT_SCRIPT = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local maximum = tonumber(ARGV[1])
if current >= maximum then
  return {0, current}
end

current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2]))
end
return {1, current}
`;

// INCR and its expiry in one round trip, so a crash between the two can never
// leave a counter without a TTL. The PTTL check also heals any such key left
// by the earlier two-command implementation.
const FIXED_WINDOW_COUNTER_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 or redis.call('PTTL', KEYS[1]) < 0 then
  redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[1]))
end
return current
`;

// Snapshot and its metadata record are written together with one TTL.
const SAMPLE_SNAPSHOT_WRITE_SCRIPT = `
redis.call('SET', KEYS[1], ARGV[1], 'EX', tonumber(ARGV[3]))
redis.call('SET', KEYS[2], ARGV[2], 'EX', tonumber(ARGV[3]))
return 1
`;

// Exported (with kvConfig/kvCommand) for lib/cache.ts, which keeps its
// durable buckets in the same store under a "cache:" key prefix.
export type KvConfig = { url: string; token: string };

let previewKvWarningLogged = false;

// Preview deployments (including dependabot/* branch builds) must not touch
// the production KV unless explicitly opted in. When blocked, the store
// behaves exactly as if no KV were configured and uses the filesystem.
export function isPreviewKvBlocked(): boolean {
  return (
    process.env.VERCEL_ENV === "preview" &&
    process.env.ALLOW_PREVIEW_KV !== "true"
  );
}

export function kvConfig(): KvConfig | null {
  if (isPreviewKvBlocked()) {
    if (!previewKvWarningLogged && hasRawKvConfig()) {
      previewKvWarningLogged = true;
      logger.warn(
        "KV credentials ignored on a preview deployment; using the filesystem store (set ALLOW_PREVIEW_KV=true to override)"
      );
    }
    return null;
  }
  const configurations = [
    {
      url: process.env.KV_REST_API_URL?.trim() ?? "",
      token: process.env.KV_REST_API_TOKEN?.trim() ?? "",
    },
    {
      url: process.env.UPSTASH_REDIS_REST_URL?.trim() ?? "",
      token: process.env.UPSTASH_REDIS_REST_TOKEN?.trim() ?? "",
    },
  ];
  const configured = configurations.find(({ url, token }) => url && token);
  if (configured) {
    return {
      url: configured.url.replace(/\/$/, ""),
      token: configured.token,
    };
  }
  return null;
}

function hasAnyKvConfig(): boolean {
  return !isPreviewKvBlocked() && hasRawKvConfig();
}

function hasRawKvConfig(): boolean {
  return Boolean(
    process.env.KV_REST_API_URL ||
      process.env.KV_REST_API_TOKEN ||
      process.env.UPSTASH_REDIS_REST_URL ||
      process.env.UPSTASH_REDIS_REST_TOKEN
  );
}

// Returns true when a durable external store is configured. Callers can use
// this to decide whether persistence-dependent features are available.
export function isDurableStoreConfigured(): boolean {
  return kvConfig() !== null;
}

function requireDurableStoreForHostedReports(): void {
  const hosted = process.env.VERCEL === "1" || Boolean(process.env.VERCEL_ENV);
  if (hosted && !isPreviewKvBlocked() && !isDurableStoreConfigured()) {
    throw new Error(
      "Durable report storage is not configured for this hosted deployment."
    );
  }
}

export async function kvCommand(
  cfg: KvConfig,
  command: (string | number)[]
): Promise<unknown> {
  const res = await fetch(cfg.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
    cache: "no-store",
    signal: AbortSignal.timeout(KV_REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`KV command failed with HTTP ${res.status}`);
  }
  const json = (await res.json()) as { result?: unknown; error?: string };
  if (json.error) throw new Error(`KV error: ${json.error}`);
  return json.result ?? null;
}

export function newReportId(): string {
  return crypto.randomBytes(9).toString("base64url"); // 12 URL-safe chars
}

export function isValidReportId(id: string): boolean {
  return ID_PATTERN.test(id);
}

// ---- filesystem fallback ---------------------------------------------------

// turbopackIgnore keeps Next's file tracer from treating this dynamic,
// env-driven path as a signal to trace the whole project into the serverless
// bundle (same fix as lib/cache.ts's getCacheRoot).
function storeRoot(): string {
  const base = process.env.CACHE_DIR
    ? path.resolve(/* turbopackIgnore: true */ process.cwd(), process.env.CACHE_DIR)
    : path.resolve(process.cwd(), ".cache");
  return path.join(base, "store");
}

async function fsSavePayload(
  directory: string,
  id: string,
  payload: string
): Promise<void> {
  const dir = path.join(storeRoot(), directory);
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, `${id}.json`);
  const temporary = `${target}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  await fs.writeFile(temporary, payload, "utf8");
  await fs.rename(temporary, target);
}

async function fsGetPayload(directory: string, id: string): Promise<string | null> {
  try {
    return await fs.readFile(
      path.join(storeRoot(), directory, `${id}.json`),
      "utf8"
    );
  } catch {
    return null;
  }
}

let fsWaitlistAdmissionTail: Promise<void> = Promise.resolve();

function serializeFsWaitlistAdmission<T>(operation: () => Promise<T>): Promise<T> {
  const run = fsWaitlistAdmissionTail.then(operation, operation);
  fsWaitlistAdmissionTail = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function fsAdmitWaitlist(
  email: string,
  entry: string,
  now: number
): Promise<WaitlistAdmission> {
  const dir = storeRoot();
  await fs.mkdir(dir, { recursive: true });
  const setFile = path.join(dir, "waitlist-emails.json");
  const entriesFile = path.join(dir, "waitlist-entries.jsonl");
  let seen: string[] = [];
  try {
    seen = JSON.parse(await fs.readFile(setFile, "utf8")) as string[];
  } catch {
    seen = [];
  }
  const normalized = email.toLowerCase();
  const exists = seen.includes(normalized);
  if (exists) {
    await fs.appendFile(entriesFile, entry + "\n");
    return { outcome: "exists" };
  }

  const capacity = inspectFixedWindowRateLimit(
    WAITLIST_GLOBAL_LIMIT_KEY,
    WINDOW_MS,
    WAITLIST_NEW_SIGNUPS_PER_WINDOW,
    now
  );
  if (!capacity.allowed) {
    return { outcome: "rate_limited", retryAfterMs: capacity.resetMs };
  }

  const previousSeen = [...seen];
  seen.push(normalized);
  await fs.writeFile(setFile, JSON.stringify(seen, null, 2), "utf8");
  try {
    await fs.appendFile(entriesFile, entry + "\n");
  } catch (error) {
    // Keep the two-file fallback consistent when the append fails.
    await fs.writeFile(setFile, JSON.stringify(previousSeen, null, 2), "utf8");
    throw error;
  }
  checkFixedWindowRateLimit(
    WAITLIST_GLOBAL_LIMIT_KEY,
    WINDOW_MS,
    WAITLIST_NEW_SIGNUPS_PER_WINDOW,
    now
  );
  return { outcome: "added" };
}

// ---- public API ------------------------------------------------------------

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function parseStoredReport(raw: string, expectedId: string): ReportReadOutcome {
  try {
    const value = JSON.parse(raw) as Partial<StoredReport>;
    if (
      value.schemaVersion !== 2 ||
      value.id !== expectedId ||
      !isIsoDate(value.createdAt) ||
      !value.report
    ) {
      return { status: "invalid" };
    }
    assertRealDataResponse(value.report);
    return { status: "ok", value: value as StoredReport };
  } catch {
    return { status: "invalid" };
  }
}

function parseSampleSnapshot(raw: string, catalogId: string): SampleReadOutcome {
  try {
    const value = JSON.parse(raw) as Partial<SampleSnapshotV2>;
    if (
      value.schemaVersion !== 2 ||
      value.catalogId !== catalogId ||
      typeof value.sampleId !== "string" ||
      !isValidReportId(value.sampleId) ||
      typeof value.reportId !== "string" ||
      !isValidReportId(value.reportId) ||
      !isIsoDate(value.generatedAt) ||
      !value.report
    ) {
      return { status: "invalid" };
    }
    assertRealDataResponse(value.report);
    return { status: "ok", value: value as SampleSnapshotV2 };
  } catch {
    return { status: "invalid" };
  }
}

export async function saveReport(report: AnalyzeMarketResponse): Promise<string> {
  assertRealDataResponse(report);
  requireDurableStoreForHostedReports();
  const id = newReportId();
  const payload = JSON.stringify({
    schemaVersion: 2,
    id,
    createdAt: new Date().toISOString(),
    report,
  });
  const cfg = kvConfig();
  if (!cfg && hasAnyKvConfig()) throw new Error("Incomplete KV configuration");
  if (cfg) {
    await kvCommand(cfg, [
      "SET",
      `report:v2:${id}`,
      payload,
      "EX",
      REPORT_TTL_SECONDS,
    ]);
  } else {
    await fsSavePayload("report-v2", id, payload);
  }
  return id;
}

export async function readReportV2(id: string): Promise<ReportReadOutcome> {
  requireDurableStoreForHostedReports();
  if (!isValidReportId(id)) return { status: "missing" };
  const cfg = kvConfig();
  if (!cfg && hasAnyKvConfig()) throw new Error("Incomplete KV configuration");
  const raw = cfg
    ? ((await kvCommand(cfg, ["GET", `report:v2:${id}`])) as string | null)
    : await fsGetPayload("report-v2", id);
  if (raw) return parseStoredReport(raw, id);

  const legacy = cfg
    ? ((await kvCommand(cfg, ["GET", `report:${id}`])) as string | null)
    : await fsGetPayload("reports", id);
  return legacy ? { status: "legacy" } : { status: "missing" };
}

export async function getReport(id: string): Promise<StoredReport | null> {
  const outcome = await readReportV2(id);
  return outcome.status === "ok" ? outcome.value : null;
}

export async function replaceSampleSnapshot(
  snapshot: SampleSnapshotV2
): Promise<void> {
  if (
    snapshot.schemaVersion !== 2 ||
    !isValidReportId(snapshot.sampleId) ||
    !isValidReportId(snapshot.reportId) ||
    !CATALOG_ID_PATTERN.test(snapshot.catalogId) ||
    !isIsoDate(snapshot.generatedAt)
  ) {
    throw new Error("Invalid v2 sample snapshot envelope.");
  }
  assertRealDataResponse(snapshot.report);
  requireDurableStoreForHostedReports();
  const payload = JSON.stringify(snapshot);
  const metaPayload = JSON.stringify(sampleMetaFromSnapshot(snapshot));
  const cfg = kvConfig();
  if (!cfg && hasAnyKvConfig()) throw new Error("Incomplete KV configuration");
  if (cfg) {
    await kvCommand(cfg, [
      "EVAL",
      SAMPLE_SNAPSHOT_WRITE_SCRIPT,
      2,
      sampleKey(snapshot.catalogId),
      sampleMetaKey(snapshot.catalogId),
      payload,
      metaPayload,
      SAMPLE_SNAPSHOT_TTL_SECONDS,
    ]);
  } else {
    await fsSavePayload("sample-v2", snapshot.catalogId, payload);
    await fsSavePayload("sample-v2-meta", snapshot.catalogId, metaPayload);
  }
}

// Catalog ids cannot contain ':', so the meta keyspace never collides with a
// snapshot key.
function sampleKey(catalogId: string): string {
  return `sample:v2:${catalogId}`;
}

function sampleMetaKey(catalogId: string): string {
  return `sample:v2:meta:${catalogId}`;
}

function sampleMetaFromSnapshot(
  snapshot: Pick<
    SampleSnapshotV2,
    "catalogId" | "sampleId" | "reportId" | "generatedAt"
  >
): SampleSnapshotMeta {
  return {
    schemaVersion: 2,
    catalogId: snapshot.catalogId,
    sampleId: snapshot.sampleId,
    reportId: snapshot.reportId,
    generatedAt: snapshot.generatedAt,
  };
}

function parseSampleMeta(raw: string, catalogId: string): SampleMetaReadOutcome {
  try {
    const value = JSON.parse(raw) as Partial<SampleSnapshotMeta>;
    if (
      value.schemaVersion !== 2 ||
      value.catalogId !== catalogId ||
      typeof value.sampleId !== "string" ||
      !isValidReportId(value.sampleId) ||
      typeof value.reportId !== "string" ||
      !isValidReportId(value.reportId) ||
      !isIsoDate(value.generatedAt)
    ) {
      return { status: "invalid" };
    }
    return {
      status: "ok",
      value: sampleMetaFromSnapshot({
        catalogId: value.catalogId,
        sampleId: value.sampleId,
        reportId: value.reportId,
        generatedAt: value.generatedAt,
      }),
    };
  } catch {
    return { status: "invalid" };
  }
}

const CATALOG_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Reads only the small metadata records (one MGET on KV). A snapshot written
// before metadata existed has none: that id falls back to reading the full
// snapshot once, and a valid one gets its metadata backfilled so later reads
// stay cheap. Backfill is best-effort; a failed write only costs a re-read.
export async function readSampleMetas(
  catalogIds: readonly string[]
): Promise<CatalogSampleMetaRead[]> {
  requireDurableStoreForHostedReports();
  const cfg = kvConfig();
  if (!cfg && hasAnyKvConfig()) throw new Error("Incomplete KV configuration");
  const validIds = catalogIds.filter((id) => CATALOG_ID_PATTERN.test(id));
  let metaRaw: Array<string | null> = [];
  if (validIds.length > 0) {
    metaRaw = cfg
      ? ((await kvCommand(cfg, ["MGET", ...validIds.map(sampleMetaKey)])) as Array<
          string | null
        >)
      : await Promise.all(validIds.map((id) => fsGetPayload("sample-v2-meta", id)));
  }
  const outcomes = new Map<string, SampleMetaReadOutcome>();
  const withoutMeta: string[] = [];
  validIds.forEach((id, index) => {
    const raw = metaRaw[index];
    if (raw) outcomes.set(id, parseSampleMeta(raw, id));
    else withoutMeta.push(id);
  });

  if (withoutMeta.length > 0) {
    const snapshotRaw = cfg
      ? ((await kvCommand(cfg, ["MGET", ...withoutMeta.map(sampleKey)])) as Array<
          string | null
        >)
      : await Promise.all(withoutMeta.map((id) => fsGetPayload("sample-v2", id)));
    const backfill: SampleSnapshotMeta[] = [];
    withoutMeta.forEach((id, index) => {
      const raw = snapshotRaw[index];
      if (!raw) {
        outcomes.set(id, { status: "missing" });
        return;
      }
      const parsed = parseSampleSnapshot(raw, id);
      if (parsed.status !== "ok") {
        outcomes.set(id, { status: "invalid" });
        return;
      }
      const meta = sampleMetaFromSnapshot(parsed.value);
      outcomes.set(id, { status: "ok", value: meta });
      backfill.push(meta);
    });
    await Promise.all(
      backfill.map(async (meta) => {
        try {
          const payload = JSON.stringify(meta);
          if (cfg) {
            // Expire with the snapshot's own age window (generatedAt + TTL)
            // rather than a fresh 30 days, so a backfilled record does not
            // outlive the snapshot it describes. A snapshot already past that
            // window (pre-TTL keys never expire) still gets a record so it is
            // not re-read on every health call; the pool's age filter
            // excludes it either way.
            const remainingSeconds = Math.ceil(
              (Date.parse(meta.generatedAt) +
                SAMPLE_SNAPSHOT_TTL_SECONDS * 1000 -
                Date.now()) /
                1000
            );
            await kvCommand(cfg, [
              "SET",
              sampleMetaKey(meta.catalogId),
              payload,
              "EX",
              remainingSeconds > 0
                ? Math.min(remainingSeconds, SAMPLE_SNAPSHOT_TTL_SECONDS)
                : SAMPLE_SNAPSHOT_TTL_SECONDS,
            ]);
          } else {
            await fsSavePayload("sample-v2-meta", meta.catalogId, payload);
          }
        } catch {
          // Best-effort; the next read falls back to the snapshot again.
        }
      })
    );
  }

  return catalogIds.map((catalogId) => ({
    catalogId,
    outcome: outcomes.get(catalogId) ?? { status: "invalid" },
  }));
}

export async function readSampleSnapshotsV2(
  catalogIds: readonly string[]
): Promise<CatalogSampleRead[]> {
  requireDurableStoreForHostedReports();
  const cfg = kvConfig();
  if (!cfg && hasAnyKvConfig()) throw new Error("Incomplete KV configuration");
  if (catalogIds.length === 0) return [];
  // Pre-v2 `sample:<id>` keys are no longer consulted: no caller treats a
  // legacy snapshot differently from a missing one, so the second MGET was
  // pure cost. The "legacy" outcome stays in the type for compatibility.
  const current: Array<string | null> = cfg
    ? ((await kvCommand(cfg, ["MGET", ...catalogIds.map(sampleKey)])) as Array<
        string | null
      >)
    : await Promise.all(catalogIds.map((id) => fsGetPayload("sample-v2", id)));

  return catalogIds.map((catalogId, index) => {
    if (!CATALOG_ID_PATTERN.test(catalogId)) {
      return { catalogId, outcome: { status: "invalid" } };
    }
    const raw = current[index];
    return {
      catalogId,
      outcome: raw ? parseSampleSnapshot(raw, catalogId) : { status: "missing" },
    };
  });
}

export async function admitWaitlistEmail(
  email: string,
  meta: Record<string, unknown> = {},
  now: number = Date.now()
): Promise<WaitlistAdmission> {
  const normalized = email.toLowerCase();
  const entry = JSON.stringify({
    email: normalized,
    at: new Date(now).toISOString(),
    ...meta,
  });
  const cfg = kvConfig();
  if (!cfg) {
    if (hasAnyKvConfig()) throw new Error("Incomplete KV configuration");
    return serializeFsWaitlistAdmission(() =>
      fsAdmitWaitlist(normalized, entry, now)
    );
  }

  const windowId = Math.floor(now / WINDOW_MS);
  const resetMs = WINDOW_MS - (now % WINDOW_MS);
  const limitKey = `rl:${WAITLIST_GLOBAL_LIMIT_KEY}:${windowId}`;
  const result = await kvCommand(cfg, [
    "EVAL",
    WAITLIST_ADMISSION_SCRIPT,
    3,
    WAITLIST_EMAILS_KEY,
    WAITLIST_ENTRIES_KEY,
    limitKey,
    normalized,
    entry,
    WAITLIST_NEW_SIGNUPS_PER_WINDOW,
    resetMs,
    WAITLIST_TTL_SECONDS,
  ]);
  if (!Array.isArray(result)) throw new Error("Invalid KV admission response");
  const code = Number(result[0]);
  if (code === 0) return { outcome: "exists" };
  if (code === 1) return { outcome: "added" };
  if (code === 2) return { outcome: "rate_limited", retryAfterMs: resetMs };
  throw new Error("Unknown KV admission response");
}

// Fixed-window rate-limit counter backed by KV, for distributed limiting
// across serverless instances. Returns null when KV is not configured so the
// caller can fall back to the in-memory limiter.
export async function kvRateLimit(
  clientKey: string,
  windowMs: number,
  maxPerWindow: number,
  now: number = Date.now()
): Promise<{ allowed: boolean; remaining: number; resetMs: number } | null> {
  const cfg = kvConfig();
  if (!cfg) {
    if (hasAnyKvConfig()) throw new Error("Incomplete KV configuration");
    return null;
  }

  const windowId = Math.floor(now / windowMs);
  const key = `rl:${clientKey}:${windowId}`;
  const count = Number(
    await kvCommand(cfg, ["EVAL", FIXED_WINDOW_COUNTER_SCRIPT, 1, key, windowMs])
  );
  if (!Number.isFinite(count)) throw new Error("Invalid KV rate-limit response");
  const resetMs = windowMs - (now % windowMs);
  return {
    allowed: count <= maxPerWindow,
    remaining: Math.max(0, maxPerWindow - count),
    resetMs,
  };
}

// Read-only look at a kvRateLimit counter: how many attempts this window has
// already counted, without adding one. Null when KV is not configured.
export async function kvRateLimitCount(
  clientKey: string,
  windowMs: number,
  now: number = Date.now()
): Promise<{ count: number; resetMs: number } | null> {
  const cfg = kvConfig();
  if (!cfg) {
    if (hasAnyKvConfig()) throw new Error("Incomplete KV configuration");
    return null;
  }
  const windowId = Math.floor(now / windowMs);
  const raw = await kvCommand(cfg, ["GET", `rl:${clientKey}:${windowId}`]);
  const count = raw === null ? 0 : Number(raw);
  if (!Number.isFinite(count)) throw new Error("Invalid KV rate-limit response");
  return { count, resetMs: windowMs - (now % windowMs) };
}

// Atomic capped variant for global ceilings. Unlike the legacy per-IP limiter,
// a denied attempt does not increment the Redis counter.
export async function kvCappedRateLimit(
  clientKey: string,
  windowMs: number,
  maxPerWindow: number,
  now: number = Date.now()
): Promise<{ allowed: boolean; remaining: number; resetMs: number } | null> {
  const cfg = kvConfig();
  if (!cfg) {
    if (hasAnyKvConfig()) throw new Error("Incomplete KV configuration");
    return null;
  }

  const windowId = Math.floor(now / windowMs);
  const key = `rl:${clientKey}:${windowId}`;
  const resetMs = windowMs - (now % windowMs);
  const result = await kvCommand(cfg, [
    "EVAL",
    CAPPED_RATE_LIMIT_SCRIPT,
    1,
    key,
    maxPerWindow,
    resetMs,
  ]);
  if (!Array.isArray(result)) throw new Error("Invalid KV rate-limit response");
  const allowed = Number(result[0]) === 1;
  const count = Number(result[1]);
  return {
    allowed,
    remaining: Math.max(0, maxPerWindow - count),
    resetMs,
  };
}
