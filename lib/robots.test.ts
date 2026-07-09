import { beforeAll, describe, expect, it } from "vitest";
import { isPathAllowed, isPathAllowedByRules, selectRules } from "./robots";

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

  it("fails open on empty or malformed content", () => {
    expect(allowed("", "/anything")).toBe(true);
    expect(allowed("complete garbage\nno colons here", "/x")).toBe(true);
    // Rules before any user-agent group are ignored per spec.
    expect(allowed("Disallow: /", "/x")).toBe(true);
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
