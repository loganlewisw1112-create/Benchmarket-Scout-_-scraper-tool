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

const windows = new Map<string, WindowEntry>();

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
