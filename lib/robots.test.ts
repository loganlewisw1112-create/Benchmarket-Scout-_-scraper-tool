import { beforeAll, describe, expect, it } from "vitest";
import {
  isPathAllowed,
  isPathAllowedByRules,
  MAX_PATH_LENGTH,
  MAX_RULE_LENGTH,
  MAX_RULES_PER_GROUP,
  MAX_WILDCARDS_PER_RULE,
  ruleMatchesPath,
  selectRules,
} from "./robots";

function allowed(robotsTxt: string, path: string, token?: string): boolean {
  return isPathAllowedByRules(selectRules(robotsTxt, token), path);
}

describe("robots.txt parsing and evaluation (offline)", () => {
  it("blocks everything under a full disallow", () => {
    const robots = "User-agent: *\nDisallow: /";
    expect(allowed(robots, "/")).toBe(false);
    expect(allowed(robots, "/any/page")).toBe(false);
  });

  it("blocks only the disallowed prefix", () => {
    const robots = "User-agent: *\nDisallow: /private/";
    expect(allowed(robots, "/private/report")).toBe(false);
    expect(allowed(robots, "/public")).toBe(true);
    expect(allowed(robots, "/")).toBe(true);
  });

  it("lets the longest matching rule win, with Allow beating Disallow on ties", () => {
    const robots =
      "User-agent: *\nDisallow: /shop\nAllow: /shop/public";
    expect(allowed(robots, "/shop/cart")).toBe(false);
    expect(allowed(robots, "/shop/public/item")).toBe(true);
  });

  it("selects our user-agent group over the wildcard group", () => {
    const blockUsOnly =
      "User-agent: benchmarkscout\nDisallow: /\n\nUser-agent: *\nDisallow: /nothing";
    expect(allowed(blockUsOnly, "/page")).toBe(false);

    const exemptUs =
      "User-agent: benchmarkscout\nDisallow:\n\nUser-agent: *\nDisallow: /";
    expect(allowed(exemptUs, "/page")).toBe(true);
  });

  it("supports consecutive user-agent lines sharing one rule set", () => {
    const robots =
      "User-agent: somebot\nUser-agent: benchmarkscout\nDisallow: /blocked";
    expect(allowed(robots, "/blocked/x")).toBe(false);
    expect(allowed(robots, "/open")).toBe(true);
  });

  it("merges repeated groups for our agent (RFC 9309 2.2.1)", () => {
    const split = [
      "User-agent: benchmarkscout",
      "Disallow: /a",
      "",
      "User-agent: *",
      "Disallow: /",
      "",
      "User-agent: BenchmarkScout",
      "Disallow: /b",
    ].join("\n");
    expect(allowed(split, "/a/x")).toBe(false);
    expect(allowed(split, "/b/x")).toBe(false);
    // Our group exists, so the "*" group does not apply.
    expect(allowed(split, "/c")).toBe(true);
  });

  it("binds only an exact product-token match, never a substring", () => {
    const partial = [
      "User-agent: scout",
      "Disallow: /",
      "",
      "User-agent: *",
      "Disallow: /private",
    ].join("\n");
    expect(allowed(partial, "/page")).toBe(true);
    expect(allowed(partial, "/private/x")).toBe(false);
  });

  it("supports * wildcards and $ end anchors", () => {
    const wildcard = "User-agent: *\nDisallow: /*?sort=";
    expect(allowed(wildcard, "/list?sort=asc")).toBe(false);
    expect(allowed(wildcard, "/list?page=2")).toBe(true);

    const anchored = "User-agent: *\nDisallow: /*.pdf$";
    expect(allowed(anchored, "/files/report.pdf")).toBe(false);
    expect(allowed(anchored, "/files/report.pdfx")).toBe(true);
  });

  it("strips comments and ignores unknown directives", () => {
    const robots = [
      "# global rules",
      "User-agent: *",
      "Crawl-delay: 10",
      "Disallow: /admin # keep bots out",
      "Sitemap: https://example.org/sitemap.xml",
    ].join("\n");
    expect(allowed(robots, "/admin/panel")).toBe(false);
    expect(allowed(robots, "/home")).toBe(true);
  });

  it("anchors `$` after a wildcard without overlapping earlier segments", () => {
    const robots = "User-agent: *\nDisallow: /a*ba$";
    expect(allowed(robots, "/aba")).toBe(false);
    expect(allowed(robots, "/axxba")).toBe(false);
    expect(allowed(robots, "/ab")).toBe(true);
    // "/a" + "ba" would need to overlap the leading "a" here.
    expect(allowed("User-agent: *\nDisallow: /ab*b$", "/ab")).toBe(true);
    expect(allowed("User-agent: *\nDisallow: /exact$", "/exact")).toBe(false);
    expect(allowed("User-agent: *\nDisallow: /exact$", "/exact/")).toBe(true);
  });

  it("fails open on empty or malformed content", () => {
    expect(allowed("", "/anything")).toBe(true);
    expect(allowed("complete garbage\nno colons here", "/x")).toBe(true);
    // Rules before any user-agent group are ignored per spec.
    expect(allowed("Disallow: /", "/x")).toBe(true);
  });
});

describe("robots.txt matcher bounds (SEC-1)", () => {
  it("evaluates pathological wildcard rules against a long path in linear time", () => {
    // With the old regex translation, 5 wildcards on a 120-char path took
    // ~650 ms and 40 such rules on a 280-char path blocked for ~66 s.
    const rules = Array.from(
      { length: MAX_RULES_PER_GROUP },
      (_, i) => `Disallow: /${"*a".repeat(MAX_WILDCARDS_PER_RULE)}b${i}$`
    );
    const robots = ["User-agent: *", ...rules].join("\n");
    const path = `/${"a".repeat(MAX_PATH_LENGTH)}`;

    const started = performance.now();
    expect(allowed(robots, path)).toBe(true);
    expect(performance.now() - started).toBeLessThan(50);
  });

  it("ignores rules over the length or wildcard caps", () => {
    const tooLong = `/${"x".repeat(MAX_RULE_LENGTH)}`;
    expect(allowed(`User-agent: *\nDisallow: ${tooLong}`, tooLong)).toBe(true);

    const tooWild = `/${"*".repeat(MAX_WILDCARDS_PER_RULE + 1)}`;
    expect(allowed(`User-agent: *\nDisallow: ${tooWild}`, "/x")).toBe(true);

    const atCap = `/${"*".repeat(MAX_WILDCARDS_PER_RULE)}`;
    expect(allowed(`User-agent: *\nDisallow: ${atCap}`, "/x")).toBe(false);
  });

  it("keeps at most MAX_RULES_PER_GROUP rules per group", () => {
    const filler = Array.from(
      { length: MAX_RULES_PER_GROUP },
      (_, i) => `Disallow: /filler-${i}`
    );
    const robots = ["User-agent: *", ...filler, "Disallow: /late"].join("\n");
    expect(selectRules(robots)).toHaveLength(MAX_RULES_PER_GROUP);
    expect(allowed(robots, "/late")).toBe(true);
    expect(allowed(robots, "/filler-0")).toBe(false);
  });

  it("matches prefix rules against paths truncated to MAX_PATH_LENGTH", () => {
    const path = `/private/${"p".repeat(MAX_PATH_LENGTH * 2)}`;
    expect(allowed("User-agent: *\nDisallow: /private/", path)).toBe(false);
  });

  it("matches rules directly via ruleMatchesPath", () => {
    expect(ruleMatchesPath("/*", "/anything")).toBe(true);
    expect(ruleMatchesPath("/a*b*c", "/aXbYcZ")).toBe(true);
    expect(ruleMatchesPath("/a*b*c$", "/aXbYcZ")).toBe(false);
    expect(ruleMatchesPath("/a*c", "/ab")).toBe(false);
  });
});

describe("isPathAllowed STRICT_ROBOTS gate", () => {
  beforeAll(() => {
    process.env.STRICT_ROBOTS = "false";
  });

  it("allows everything without fetching when strict mode is off", async () => {
    // Would require a network fetch if the gate were broken; the private
    // address also guarantees no real request could succeed.
    await expect(isPathAllowed("https://127.0.0.1/page")).resolves.toBe(true);
  });
});
