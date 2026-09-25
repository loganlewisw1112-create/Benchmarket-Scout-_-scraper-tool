// Public-endpoint abuse guard for the hosted deployment.
//
// Composes the protections that any public route can opt into:
//   1. Optional access-key gate. Enabled by setting either SCOUT_API_KEY_HASH
//      (recommended: the SHA-256 hex of the key, so the raw secret never lives
//      in the deployment env) or SCOUT_API_KEY (raw). Requests present the key
//      via the `x-scout-key` header only (never the URL, which ends up in
//      logs and history). Comparison is constant-time over SHA-256 digests.
//      When neither is set, the endpoint is open.
//   2. Per-IP rate limiting in named buckets, so a burst on one endpoint does
//      not lock a client out of another. Uses a KV-backed fixed-window
//      counter when a durable store is configured (correct across serverless
//      instances), and falls back to the per-instance in-memory limiter
//      otherwise. KV errors fail open to the in-memory limiter so a store
//      hiccup never 500s the API.
//   3. A same-site JSON check for state-changing POSTs (enforceSameSiteJsonPost).
//
// Every failure carries a SCREAMING_SNAKE `code` so routes can return the
// shared `{ code, error }` error body.

import crypto from "node:crypto";
import {
  checkFixedWindowRateLimit,
  checkRateLimit,
  inspectRateLimit,
  WINDOW_MS,
} from "./rate-limit";
import { kvCappedRateLimit, kvRateLimit, kvRateLimitCount } from "./store";

export type GuardBucket =
  | "analyze"
  | "sample"
  | "waitlist"
  | "reports"
  | "refresh-auth";

// Requests per client IP per WINDOW_MS (one minute).
export const GUARD_BUCKET_LIMITS: Readonly<Record<GuardBucket, number>> = {
  analyze: 10,
  sample: 30,
  waitlist: 5,
  reports: 60,
  "refresh-auth": 10,
};

// Buckets behind the beta access-code gate. Shared report links must open
// for anyone holding the link, and the sample refresh route authenticates
// with its own secret, so those buckets are rate-limited only.
const ACCESS_KEY_BUCKETS: ReadonlySet<GuardBucket> = new Set<GuardBucket>([
  "analyze",
  "sample",
  "waitlist",
]);

export type GuardErrorCode =
  | "ACCESS_CODE_REQUIRED"
  | "RATE_LIMITED"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "CROSS_SITE_REQUEST";

export type GuardResult =
  | { ok: true }
  | {
      ok: false;
      status: number;
      code: GuardErrorCode;
      error: string;
      retryAfterMs?: number;
    };

export type GuardOptions = { bucket?: GuardBucket };

export const GLOBAL_ANALYSES_PER_WINDOW = 30;

// Stored as rl:global:analyze-market:<window>. Per-IP keys live under
// rl:ip:<bucket>:..., so a crafted client key can never collide with it.
const GLOBAL_ANALYZE_KEY = "global:analyze-market";

type GlobalLimitBackend = "kv" | "memory";

export type GlobalLimitResult =
  | { ok: true; backend: GlobalLimitBackend; reservedAt: number }
  | {
      ok: false;
      status: 429 | 503;
      code: "RATE_LIMITED" | "RATE_LIMIT_UNAVAILABLE";
      error: string;
      retryAfterMs: number;
    };

// Longest plausible client address (IPv6 with an embedded IPv4 tail) plus
// slack. Anything longer is not an address and is truncated.
const MAX_CLIENT_KEY_LENGTH = 64;

type HeaderReader = Pick<Headers, "get">;

// First hop of x-forwarded-for when behind a proxy (Vercel sets this to the
// real client IP); a shared fallback key otherwise so a single local instance
// still bounds total throughput. Restricted to address characters so the
// value is safe to embed in a KV key.
export function clientKeyFromHeaders(headers: HeaderReader): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "";
  const sanitized = forwarded
    .replace(/[^0-9A-Za-z:.%_-]/g, "")
    .slice(0, MAX_CLIENT_KEY_LENGTH);
  return sanitized || "local";
}

export function clientKeyFrom(request: Request): string {
  return clientKeyFromHeaders(request.headers);
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
  const provided = request.headers.get("x-scout-key") ?? "";
  if (!provided) return false;
  return keyMatches(provided);
}

async function limit(
  bucket: GuardBucket,
  clientKey: string
): Promise<{ allowed: boolean; resetMs: number }> {
  const key = `ip:${bucket}:${clientKey}`;
  const maxPerWindow = GUARD_BUCKET_LIMITS[bucket];
  try {
    const kv = await kvRateLimit(key, WINDOW_MS, maxPerWindow);
    if (kv) return { allowed: kv.allowed, resetMs: kv.resetMs };
  } catch {
    // Fall through to the in-memory limiter on any KV error.
  }
  const local = checkRateLimit(key, Date.now(), maxPerWindow);
  return { allowed: local.allowed, resetMs: local.resetMs };
}

/** Whether `bucket` is already exhausted for this client, without counting. */
async function peekLimit(
  bucket: GuardBucket,
  clientKey: string
): Promise<{ allowed: boolean; resetMs: number }> {
  const key = `ip:${bucket}:${clientKey}`;
  const maxPerWindow = GUARD_BUCKET_LIMITS[bucket];
  try {
    const kv = await kvRateLimitCount(key, WINDOW_MS);
    if (kv) return { allowed: kv.count < maxPerWindow, resetMs: kv.resetMs };
  } catch {
    // Fall through to the in-memory limiter on any KV error, as limit() does.
  }
  const local = inspectRateLimit(key, Date.now(), maxPerWindow);
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
      code: "RATE_LIMIT_UNAVAILABLE",
      error:
        "Traffic controls are temporarily unavailable. Please wait a moment and try again.",
      retryAfterMs: WINDOW_MS,
    };
  }
  if (kv) {
    return kv.allowed
      ? { ok: true, backend: "kv", reservedAt: now }
      : {
          ok: false,
          status: 429,
          code: "RATE_LIMITED",
          error,
          retryAfterMs: kv.resetMs,
        };
  }

  const local = checkFixedWindowRateLimit(
    clientKey,
    WINDOW_MS,
    maxPerWindow,
    now
  );
  return local.allowed
    ? { ok: true, backend: "memory", reservedAt: now }
    : {
        ok: false,
        status: 429,
        code: "RATE_LIMITED",
        error,
        retryAfterMs: local.resetMs,
      };
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

const RATE_LIMIT_MESSAGES: Record<GuardBucket, string> = {
  analyze:
    "Too many requests. Each analysis queries several free public services, so please wait a minute and try again.",
  sample: "Too many sample requests. Please wait a minute and try again.",
  waitlist: "Too many sign-up attempts. Please wait a minute and try again.",
  reports: "Too many report requests. Please wait a minute and try again.",
  "refresh-auth": "Too many refresh attempts. Please wait a minute and try again.",
};

/**
 * Rate-limits an already-derived client key (see clientKeyFromHeaders) in
 * `bucket`. For server components that have headers but no Request. This
 * does NOT check the access key, so key-gated buckets must enforce it
 * separately.
 */
export async function enforceGuardForKey(
  clientKey: string,
  bucket: GuardBucket = "analyze"
): Promise<GuardResult> {
  const { allowed, resetMs } = await limit(bucket, clientKey);
  if (!allowed) {
    return {
      ok: false,
      status: 429,
      code: "RATE_LIMITED",
      error: RATE_LIMIT_MESSAGES[bucket],
      retryAfterMs: resetMs,
    };
  }
  return { ok: true };
}

/**
 * Rejects with 429 when `bucket` is already exhausted for this client,
 * WITHOUT counting this request. For buckets that count only failed
 * attempts (refresh-auth): check this first, then call enforceGuard only on
 * a failure, so an exhausted client is refused before its credential is
 * even evaluated.
 */
export async function checkGuardNotExhausted(
  request: Request,
  bucket: GuardBucket
): Promise<GuardResult> {
  const { allowed, resetMs } = await peekLimit(bucket, clientKeyFrom(request));
  if (allowed) return { ok: true };
  return {
    ok: false,
    status: 429,
    code: "RATE_LIMITED",
    error: RATE_LIMIT_MESSAGES[bucket],
    retryAfterMs: resetMs,
  };
}

export async function enforceGuard(
  request: Request,
  options: GuardOptions = {}
): Promise<GuardResult> {
  const bucket = options.bucket ?? "analyze";

  if (ACCESS_KEY_BUCKETS.has(bucket) && !keyGatePasses(request)) {
    return {
      ok: false,
      status: 401,
      code: "ACCESS_CODE_REQUIRED",
      error: "This beta requires an access code. Enter yours to continue.",
    };
  }

  return enforceGuardForKey(clientKeyFrom(request), bucket);
}

function requestHost(request: Request): string {
  const forwardedHost = request.headers
    .get("x-forwarded-host")
    ?.split(",")[0]
    ?.trim();
  const host = forwardedHost || request.headers.get("host")?.trim();
  if (host) return host.toLowerCase();
  try {
    return new URL(request.url).host.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Rejects JSON POSTs a browser could send cross-site without a CORS
 * preflight: a non-JSON content type (`text/plain` "simple" requests that
 * request.json() would still parse), `Sec-Fetch-Site: cross-site`, or an
 * Origin whose host differs from the request's host. Requests with no
 * Origin (curl, server-to-server) pass the origin check.
 */
export function enforceSameSiteJsonPost(request: Request): GuardResult {
  const mediaType = (request.headers.get("content-type") ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (mediaType !== "application/json") {
    return {
      ok: false,
      status: 415,
      code: "UNSUPPORTED_MEDIA_TYPE",
      error: "Requests must be sent as JSON (Content-Type: application/json).",
    };
  }

  const crossSite: GuardResult = {
    ok: false,
    status: 403,
    code: "CROSS_SITE_REQUEST",
    error: "Cross-site requests are not allowed.",
  };

  if (request.headers.get("sec-fetch-site")?.trim().toLowerCase() === "cross-site") {
    return crossSite;
  }

  const origin = request.headers.get("origin");
  if (origin !== null) {
    let originHost = "";
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      // "null" or a malformed Origin is never same-site.
    }
    if (!originHost || originHost !== requestHost(request)) return crossSite;
  }

  return { ok: true };
}
