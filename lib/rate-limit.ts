// In-memory fixed-window rate limiter. Per-instance by design: this app
// runs as a single local instance, and each analyze-market request fans out
// to several free public services (Nominatim, Overpass, GDELT) plus target
// websites, so the goal is polite throttling rather than distributed quota.

export const WINDOW_MS = 60_000;
export const MAX_REQUESTS_PER_WINDOW = 10;

// Sweep expired windows once the map grows past this, so long-running
// processes don't accumulate one entry per client forever.
const SWEEP_THRESHOLD = 1_000;

type WindowEntry = { windowStart: number; count: number };
type FixedWindowEntry = { windowId: number; count: number };

const windows = new Map<string, WindowEntry>();
const fixedWindows = new Map<string, FixedWindowEntry>();

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  resetMs: number;
};

function sweepExpired(now: number): void {
  if (windows.size <= SWEEP_THRESHOLD) return;
  for (const [key, entry] of windows) {
    if (now - entry.windowStart >= WINDOW_MS) {
      windows.delete(key);
    }
  }
}

function sweepExpiredFixedWindows(now: number, windowMs: number): void {
  if (fixedWindows.size <= SWEEP_THRESHOLD) return;
  const currentWindowId = Math.floor(now / windowMs);
  for (const [key, entry] of fixedWindows) {
    if (entry.windowId < currentWindowId) fixedWindows.delete(key);
  }
}

// `now` is injectable for deterministic tests; production callers omit it.
export function checkRateLimit(
  key: string,
  now: number = Date.now()
): RateLimitResult {
  sweepExpired(now);

  const entry = windows.get(key);

  if (!entry || now - entry.windowStart >= WINDOW_MS) {
    windows.set(key, { windowStart: now, count: 1 });
    return {
      allowed: true,
      remaining: MAX_REQUESTS_PER_WINDOW - 1,
      resetMs: WINDOW_MS,
    };
  }

  entry.count += 1;
  const resetMs = WINDOW_MS - (now - entry.windowStart);

  if (entry.count > MAX_REQUESTS_PER_WINDOW) {
    return { allowed: false, remaining: 0, resetMs };
  }

  return {
    allowed: true,
    remaining: MAX_REQUESTS_PER_WINDOW - entry.count,
    resetMs,
  };
}

// Configurable, epoch-aligned fixed window used by the global ceilings. It is
// separate from the existing per-client limiter so that per-IP behavior stays
// unchanged. `now` remains injectable for deterministic boundary tests.
export function checkFixedWindowRateLimit(
  key: string,
  windowMs: number,
  maxPerWindow: number,
  now: number = Date.now()
): RateLimitResult {
  sweepExpiredFixedWindows(now, windowMs);

  const windowId = Math.floor(now / windowMs);
  const entry = fixedWindows.get(key);
  const resetMs = windowMs - (now % windowMs);

  if (!entry || entry.windowId !== windowId) {
    fixedWindows.set(key, { windowId, count: 1 });
    return {
      allowed: true,
      remaining: maxPerWindow - 1,
      resetMs,
    };
  }

  if (entry.count >= maxPerWindow) {
    return { allowed: false, remaining: 0, resetMs };
  }

  entry.count += 1;
  return {
    allowed: true,
    remaining: Math.max(0, maxPerWindow - entry.count),
    resetMs,
  };
}

// Read-only companion used by the serialized filesystem waitlist admission
// path. It checks capacity before persistence; a successful write then calls
// checkFixedWindowRateLimit to consume the slot.
export function inspectFixedWindowRateLimit(
  key: string,
  windowMs: number,
  maxPerWindow: number,
  now: number
): RateLimitResult {
  const windowId = Math.floor(now / windowMs);
  const entry = fixedWindows.get(key);
  const resetMs = windowMs - (now % windowMs);
  const count = entry?.windowId === windowId ? entry.count : 0;
  return {
    allowed: count < maxPerWindow,
    remaining: Math.max(0, maxPerWindow - count),
    resetMs,
  };
}
