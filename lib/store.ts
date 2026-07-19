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
import {
  checkFixedWindowRateLimit,
  inspectFixedWindowRateLimit,
  WINDOW_MS,
} from "./rate-limit";
import type { AnalyzeMarketResponse } from "./types";

const REPORT_TTL_SECONDS = 60 * 60 * 24 * 90; // 90 days
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

type KvConfig = { url: string; token: string };

function kvConfig(): KvConfig | null {
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
  if (hosted && !isDurableStoreConfigured()) {
    throw new Error(
      "Durable report storage is not configured for this hosted deployment."
    );
  }
}

async function kvCommand(
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
  const cfg = kvConfig();
  if (!cfg && hasAnyKvConfig()) throw new Error("Incomplete KV configuration");
  if (cfg) {
    await kvCommand(cfg, ["SET", `sample:v2:${snapshot.catalogId}`, payload]);
  } else {
    await fsSavePayload("sample-v2", snapshot.catalogId, payload);
  }
}

const CATALOG_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export async function readSampleSnapshotsV2(
  catalogIds: readonly string[]
): Promise<CatalogSampleRead[]> {
  requireDurableStoreForHostedReports();
  const cfg = kvConfig();
  if (!cfg && hasAnyKvConfig()) throw new Error("Incomplete KV configuration");
  let current: Array<string | null>;
  let legacy: Array<string | null>;
  if (cfg) {
    if (catalogIds.length === 0) return [];
    current = (await kvCommand(cfg, [
      "MGET",
      ...catalogIds.map((id) => `sample:v2:${id}`),
    ])) as Array<string | null>;
    const missingIds = catalogIds.filter((_, index) => !current[index]);
    const legacyById = new Map<string, string | null>();
    if (missingIds.length > 0) {
      const values = (await kvCommand(cfg, [
        "MGET",
        ...missingIds.map((id) => `sample:${id}`),
      ])) as Array<string | null>;
      missingIds.forEach((id, index) => legacyById.set(id, values[index] ?? null));
    }
    legacy = catalogIds.map((id) => legacyById.get(id) ?? null);
  } else {
    current = await Promise.all(
      catalogIds.map((id) => fsGetPayload("sample-v2", id))
    );
    legacy = await Promise.all(
      catalogIds.map((id, index) =>
        current[index] ? Promise.resolve(null) : fsGetPayload("samples", id)
      )
    );
  }

  return catalogIds.map((catalogId, index) => {
    if (!CATALOG_ID_PATTERN.test(catalogId)) {
      return { catalogId, outcome: { status: "invalid" } };
    }
    const raw = current[index];
    return {
      catalogId,
      outcome: raw
        ? parseSampleSnapshot(raw, catalogId)
        : legacy[index]
          ? { status: "legacy" }
          : { status: "missing" },
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
  const count = (await kvCommand(cfg, ["INCR", key])) as number;
  if (count === 1) {
    await kvCommand(cfg, ["PEXPIRE", key, windowMs]);
  }
  const resetMs = windowMs - (now % windowMs);
  return {
    allowed: count <= maxPerWindow,
    remaining: Math.max(0, maxPerWindow - count),
    resetMs,
  };
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
