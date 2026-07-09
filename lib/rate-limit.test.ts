import { describe, expect, it } from "vitest";
import {
  MAX_REQUESTS_PER_WINDOW,
  WINDOW_MS,
  checkRateLimit,
} from "./rate-limit";

// The limiter keeps module-level state, so every test uses its own key.
const T0 = 1_750_000_000_000;

describe("checkRateLimit", () => {
  it("allows up to the limit, then blocks within the same window", () => {
    const key = "test-limit";

    for (let i = 0; i < MAX_REQUESTS_PER_WINDOW; i++) {
      const result = checkRateLimit(key, T0 + i);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(MAX_REQUESTS_PER_WINDOW - 1 - i);
    }

    const blocked = checkRateLimit(key, T0 + MAX_REQUESTS_PER_WINDOW);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.resetMs).toBeGreaterThan(0);
    expect(blocked.resetMs).toBeLessThanOrEqual(WINDOW_MS);
  });

  it("resets after the window elapses", () => {
    const key = "test-reset";

    for (let i = 0; i <= MAX_REQUESTS_PER_WINDOW; i++) {
      checkRateLimit(key, T0);
    }
    expect(checkRateLimit(key, T0 + 1).allowed).toBe(false);

    const afterReset = checkRateLimit(key, T0 + WINDOW_MS);
    expect(afterReset.allowed).toBe(true);
    expect(afterReset.remaining).toBe(MAX_REQUESTS_PER_WINDOW - 1);
  });

  it("tracks keys independently", () => {
    for (let i = 0; i <= MAX_REQUESTS_PER_WINDOW; i++) {
      checkRateLimit("test-noisy", T0);
    }
    expect(checkRateLimit("test-noisy", T0 + 1).allowed).toBe(false);
    expect(checkRateLimit("test-quiet", T0 + 1).allowed).toBe(true);
  });
});
