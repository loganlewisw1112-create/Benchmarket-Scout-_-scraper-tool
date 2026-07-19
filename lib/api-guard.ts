// Public-endpoint abuse guard for the hosted deployment.
//
// Composes two protections that any public route can opt into:
//   1. Optional access-key gate. Enabled by setting either SCOUT_API_KEY_HASH
//      (recommended: the SHA-256 hex of the key, so the raw secret never lives
//      in the deployment env) or SCOUT_API_KEY (raw). Requests present the key
//      via the `x-scout-key` header or `?key=`. Comparison is constant-time
//      over SHA-256 digests. When neither is set, the endpoint is open.
//   2. Rate limiting. Uses a KV-backed fixed-window counter when a durable
//      store is configured (correct across serverless instances), and falls
//      back to the per-instance in-memory limiter otherwise. KV errors fail
//      open to the in-memory limiter so a store hiccup never 500s the API.

import crypto from "node:crypto";
import {
  checkFixedWindowRateLimit,
  checkRateLimit,
  MAX_REQUESTS_PER_WINDOW,
  WINDOW_MS,
} from "./rate-limit";
import { kvCappedRateLimit, kvRateLimit } from "./store";

export type GuardResult =
  | { ok: true }
  | { ok: false; status: number; error: string; retryAfterMs?: number };

export const GLOBAL_ANALYSES_PER_WINDOW = 30;

const GLOBAL_ANALYZE_KEY = "global:analyze-market";

type GlobalLimitBackend = "kv" | "memory";

export type GlobalLimitResult =
  | { ok: true; backend: GlobalLimitBackend; reservedAt: number }
  | {
      ok: false;
      status: 429 | 503;
      error: string;
      retryAfterMs: number;
    };

// First hop of x-forwarded-for when behind a proxy (Vercel sets this to the
// real client IP); a shared fallback key otherwise so a single local instance
// still bounds total throughput.
export function clientKeyFrom(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || "local";
}

function sha256(value: string): Buffer {
  return crypto.createHash("sha256").update(value).digest();
}

// True when an access-key gate is configured via env.
export function isKeyGateEnabled(): boolean {
  return Boolean(process.env.SCOUT_API_KEY_HASH || process.env.SCOUT_API_KEY);
}

function expectedDigest(): Buffer | null {
  const hex = process.env.SCOUT_API_KEY_HASH?.trim();
  if (hex) {
    const buf = Buffer.from(hex, "hex");
    return buf.length === 32 ? buf : null; // malformed hash -> no match
  }
  const raw = process.env.SCOUT_API_KEY;
  return raw ? sha256(raw) : null;
}

function keyMatches(provided: string): boolean {
  const expected = expectedDigest();
  if (!expected) return false;
  return crypto.timingSafeEqual(sha256(provided), expected);
}

function keyGatePasses(request: Request): boolean {
  if (!isKeyGateEnabled()) return true;
  const header = request.headers.get("x-scout-key");
  const provided =
    header ?? new URL(request.url).searchParams.get("key") ?? "";
  if (!provided) return false;
  return keyMatches(provided);
}

async function limit(
  clientKey: string
): Promise<{ allowed: boolean; resetMs: number }> {
  try {
    const kv = await kvRateLimit(clientKey, WINDOW_MS, MAX_REQUESTS_PER_WINDOW);
    if (kv) return { allowed: kv.allowed, resetMs: kv.resetMs };
  } catch {
    // Fall through to the in-memory limiter on any KV error.
  }
  const local = checkRateLimit(clientKey);
  return { allowed: local.allowed, resetMs: local.resetMs };
}

async function globalLimit(
  clientKey: string,
  maxPerWindow: number,
  error: string,
  now: number
): Promise<GlobalLimitResult> {
  let kv:
    | Awaited<ReturnType<typeof kvCappedRateLimit>>
    | undefined;
  try {
    kv = await kvCappedRateLimit(clientKey, WINDOW_MS, maxPerWindow, now);
  } catch {
    return {
      ok: false,
      status: 503,
      error:
        "Traffic controls are temporarily unavailable. Please wait a moment and try again.",
      retryAfterMs: WINDOW_MS,
    };
  }
  if (kv) {
    return kv.allowed
      ? { ok: true, backend: "kv", reservedAt: now }
      : { ok: false, status: 429, error, retryAfterMs: kv.resetMs };
  }

  const local = checkFixedWindowRateLimit(
    clientKey,
    WINDOW_MS,
    maxPerWindow,
    now
  );
  return local.allowed
    ? { ok: true, backend: "memory", reservedAt: now }
    : { ok: false, status: 429, error, retryAfterMs: local.resetMs };
}

export function enforceGlobalAnalyzeLimit(
  now: number = Date.now()
): Promise<GlobalLimitResult> {
  return globalLimit(
    GLOBAL_ANALYZE_KEY,
    GLOBAL_ANALYSES_PER_WINDOW,
    "Benchmark Scout is handling 30 analyses this minute. Please wait a moment and try again.",
    now
  );
}

export async function enforceGuard(request: Request): Promise<GuardResult> {
  if (!keyGatePasses(request)) {
    return {
      ok: false,
      status: 401,
      error: "This beta requires an access code. Enter yours to continue.",
    };
  }

  const { allowed, resetMs } = await limit(clientKeyFrom(request));
  if (!allowed) {
    return {
      ok: false,
      status: 429,
      error:
        "Too many requests. Each analysis queries several free public services, so please wait a minute and try again.",
      retryAfterMs: resetMs,
    };
  }
  return { ok: true };
}
