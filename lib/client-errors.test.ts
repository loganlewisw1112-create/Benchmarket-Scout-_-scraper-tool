import { describe, expect, it } from "vitest";
import {
  describeApiError,
  formatRetryAfter,
  NETWORK_ERROR_MESSAGE,
  normalizeWebsiteUrl,
  readJsonBody,
} from "./client-errors";

describe("normalizeWebsiteUrl", () => {
  it("keeps full http(s) URLs as typed", () => {
    expect(normalizeWebsiteUrl("https://acme.example.org")).toEqual({
      ok: true,
      url: "https://acme.example.org",
    });
    expect(normalizeWebsiteUrl(" http://acme.com/about ")).toEqual({
      ok: true,
      url: "http://acme.com/about",
    });
  });

  it("accepts bare domains by adding https://", () => {
    expect(normalizeWebsiteUrl("acme.com")).toEqual({ ok: true, url: "https://acme.com" });
    expect(normalizeWebsiteUrl("www.acme.co.uk/contact")).toEqual({
      ok: true,
      url: "https://www.acme.co.uk/contact",
    });
    expect(normalizeWebsiteUrl("acme.com:8080")).toEqual({
      ok: true,
      url: "https://acme.com:8080",
    });
  });

  it("rejects text that is not a website address", () => {
    for (const bad of [
      "",
      "not-a-valid-url-at-all",
      "acme dot com",
      "localhost:3000",
      "https://acme",
      "acme.c0m",
      "https://user:pass@acme.com",
      "-acme.com",
    ]) {
      expect(normalizeWebsiteUrl(bad).ok, bad).toBe(false);
    }
  });

  it("explains non-web schemes", () => {
    const result = normalizeWebsiteUrl("ftp://acme.com");
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining("http") });
    expect(normalizeWebsiteUrl("mailto:owner@acme.com").ok).toBe(false);
  });
});

describe("formatRetryAfter", () => {
  it("formats seconds and minutes", () => {
    expect(formatRetryAfter("1")).toBe("1 second");
    expect(formatRetryAfter("42")).toBe("42 seconds");
    expect(formatRetryAfter("60")).toBe("1 minute");
    expect(formatRetryAfter("3600")).toBe("60 minutes");
  });

  it("ignores missing or unusable values", () => {
    expect(formatRetryAfter(null)).toBeNull();
    expect(formatRetryAfter("soon")).toBeNull();
    expect(formatRetryAfter("0")).toBeNull();
  });
});

describe("describeApiError", () => {
  it("prefers the specific server message for input problems", () => {
    const message = describeApiError(422, {
      code: "AMBIGUOUS_MARKET",
      error: '"Springfield" matches several places (Springfield, IL; Springfield, MO).',
    }, null);
    expect(message).toContain("Springfield, IL");
  });

  it("has a friendly fallback for each pipeline code", () => {
    const codes = [
      "AMBIGUOUS_MARKET",
      "MARKET_NOT_FOUND",
      "INDUSTRY_NOT_RESOLVED",
      "NO_COMPETITORS_FOUND",
      "USER_SITE_UNAVAILABLE",
      "INSUFFICIENT_REAL_DATA",
    ];
    for (const code of codes) {
      const message = describeApiError(422, { code }, null);
      expect(message.length, code).toBeGreaterThan(20);
      expect(message).not.toMatch(/reach|connection/i);
    }
    expect(describeApiError(422, { code: "MARKET_NOT_FOUND" }, null)).toMatch(/city or market/);
    expect(describeApiError(422, { code: "USER_SITE_UNAVAILABLE" }, null)).toMatch(/website/);
  });

  it("only suggests checking the address when the user-site reason is about the address", () => {
    const slow = describeApiError(
      422,
      {
        code: "USER_SITE_UNAVAILABLE",
        error: "Your website did not respond within the analysis time limit.",
        reason: "timeout",
        retryable: true,
      },
      "60"
    );
    expect(slow).not.toMatch(/check the website address/i);
    expect(slow).toMatch(/try again/i);
    const blocked = describeApiError(
      422,
      { code: "USER_SITE_UNAVAILABLE", error: "Your website refused our check.", reason: "blocked_by_site", retryable: true },
      "60"
    );
    expect(blocked).not.toMatch(/check the website address/i);
    const dead = describeApiError(
      422,
      { code: "USER_SITE_UNAVAILABLE", error: "Your website's domain does not resolve.", reason: "dns_unresolved", retryable: false },
      null
    );
    expect(dead).toMatch(/check the website address/i);
    const robots = describeApiError(
      422,
      { code: "USER_SITE_UNAVAILABLE", error: "robots.txt disallows it.", reason: "robots_disallowed", retryable: false },
      null
    );
    expect(robots).toBe("robots.txt disallows it.");
  });

  it("tells people to retry later when a source is down, without blaming input", () => {
    for (const code of ["SOURCE_UNAVAILABLE", "ANALYSIS_TIMEOUT"]) {
      const message = describeApiError(503, { code, error: "Overpass 504" }, "60");
      expect(message).toMatch(/try again in a few minutes/);
      expect(message).not.toContain("Overpass 504");
    }
  });

  it("includes the retry time for RATE_LIMITED", () => {
    expect(describeApiError(429, { code: "RATE_LIMITED" }, "45")).toBe(
      "Too many requests right now. Please try again in 45 seconds."
    );
    expect(describeApiError(429, { code: "RATE_LIMITED" }, null)).toMatch(/wait a minute/);
  });

  it("maps UNSUPPORTED_MEDIA_TYPE to a reload hint", () => {
    expect(describeApiError(415, { code: "UNSUPPORTED_MEDIA_TYPE" }, null)).toMatch(/Reload/);
  });

  it("separates server failures from unknown client errors", () => {
    expect(describeApiError(500, { code: "INTERNAL_ERROR", error: "x" }, null)).toMatch(
      /problem on our side/
    );
    expect(describeApiError(502, null, null)).toMatch(/problem on our side/);
    expect(describeApiError(400, { error: "Invalid input." }, null)).toBe("Invalid input.");
    expect(describeApiError(404, null, null, "sample")).toMatch(/sample report/);
    expect(NETWORK_ERROR_MESSAGE).toMatch(/connection/);
  });
});

describe("readJsonBody", () => {
  it("returns null for a non-JSON error page", async () => {
    const res = new Response("<html>504 Gateway Timeout</html>", { status: 504 });
    expect(await readJsonBody(res)).toBeNull();
    expect(await readJsonBody(Response.json({ a: 1 }))).toEqual({ a: 1 });
  });
});
