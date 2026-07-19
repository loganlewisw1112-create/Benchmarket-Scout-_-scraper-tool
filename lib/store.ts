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
import {
  checkFixedWindowRateLimit,
  inspectFixedWindowRateLimit,
  WINDOW_MS,
} from "./rate-limit";

const REPORT_TTL_SECONDS = 60 * 60 * 24 * 90; // 90 days
const ID_PATTERN = /^[A-Za-z0-9_-]{6,64}$/;

export type StoredReport = {
  id: string;
  createdAt: string;
  report: unknown;
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
  const url =
    process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL ?? "";
  const token =
    process.env.KV_REST_API_TOKEN ??
    process.env.UPSTASH_REDIS_REST_TOKEN ??
    "";
  if (url && token) return { url: url.replace(/\/$/, ""), token };
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

async function fsSaveReport(id: string, payload: string): Promise<void> {
  const dir = path.join(storeRoot(), "reports");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${id}.json`), payload, "utf8");
}

async function fsGetReport(id: string): Promise<string | null> {
  try {
    return await fs.readFile(
      path.join(storeRoot(), "reports", `${id}.json`),
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

export async function saveReport(report: unknown): Promise<string> {
  const id = newReportId();
  const payload = JSON.stringify({
    id,
    createdAt: new Date().toISOString(),
    report,
  });
  const cfg = kvConfig();
  if (cfg) {
    await kvCommand(cfg, [
      "SET",
      `report:${id}`,
      payload,
      "EX",
      REPORT_TTL_SECONDS,
    ]);
  } else {
    await fsSaveReport(id, payload);
  }
  return id;
}

export async function getReport(id: string): Promise<StoredReport | null> {
  if (!isValidReportId(id)) return null;
  const cfg = kvConfig();
  const raw = cfg
    ? ((await kvCommand(cfg, ["GET", `report:${id}`])) as string | null)
    : await fsGetReport(id);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredReport;
  } catch {
    return null;
  }
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
