import { describe, expect, it } from "vitest";
import nextConfig, {
  buildContentSecurityPolicy,
  buildSecurityHeaders,
} from "@/next.config";
import robots from "@/app/robots";
import sitemap from "@/app/sitemap";
import { sharedReportMetadata } from "./share-metadata";
import { OG_IMAGE, resolveSiteUrl, SITE_URL } from "./site";

function directive(policy: string, name: string): string[] {
  const entry = policy
    .split(";")
    .map((part) => part.trim())
    .find((part) => part === name || part.startsWith(`${name} `));
  return entry ? entry.split(/\s+/).slice(1) : [];
}

describe("resolveSiteUrl", () => {
  it("defaults to the primary domain and keeps only the origin", () => {
    expect(resolveSiteUrl(undefined)).toBe("https://benchmark-scout.vercel.app");
    expect(resolveSiteUrl("  ")).toBe("https://benchmark-scout.vercel.app");
    expect(resolveSiteUrl("https://example.com/some/path")).toBe("https://example.com");
    expect(resolveSiteUrl("javascript:alert(1)")).toBe("https://benchmark-scout.vercel.app");
    expect(resolveSiteUrl("not a url")).toBe("https://benchmark-scout.vercel.app");
  });
});

describe("shared report metadata", () => {
  it("re-specifies the OG/Twitter image because metadata merging is shallow", () => {
    const meta = sharedReportMetadata("abc123", "Title", "Description");
    expect(meta.openGraph?.images).toEqual([OG_IMAGE]);
    expect(meta.twitter).toMatchObject({
      card: "summary_large_image",
      images: [OG_IMAGE],
    });
    expect(OG_IMAGE).toMatchObject({ url: "/opengraph-image.png", width: 1200, height: 630 });
    expect(meta.alternates?.canonical).toBe("/r/abc123");
    expect(meta.robots).toEqual({ index: false, follow: false });
  });
});

describe("robots.txt and sitemap.xml", () => {
  it("allows the site but keeps crawlers out of the API and shared reports", () => {
    const result = robots();
    expect(result.rules).toEqual({
      userAgent: "*",
      allow: "/",
      disallow: ["/api/", "/r/"],
    });
    expect(result.sitemap).toBe(`${SITE_URL}/sitemap.xml`);
  });

  it("lists only the indexable pages", () => {
    expect(sitemap().map((entry) => entry.url)).toEqual([
      `${SITE_URL}/`,
      `${SITE_URL}/privacy`,
    ]);
  });
});

describe("security headers", () => {
  it("sets the baseline headers on every route and hides X-Powered-By", async () => {
    expect(nextConfig.poweredByHeader).toBe(false);
    const rules = await nextConfig.headers!();
    expect(rules).toHaveLength(1);
    expect(rules[0].source).toBe("/(.*)");
    const keys = rules[0].headers.map((header) => header.key);
    expect(keys).toEqual([
      "Content-Security-Policy",
      "X-Content-Type-Options",
      "Referrer-Policy",
      "X-Frame-Options",
      "Permissions-Policy",
    ]);
    const byKey = Object.fromEntries(
      buildSecurityHeaders().map((header) => [header.key, header.value])
    );
    expect(byKey["X-Content-Type-Options"]).toBe("nosniff");
    expect(byKey["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(byKey["X-Frame-Options"]).toBe("DENY");
    expect(byKey["Permissions-Policy"]).toContain("camera=()");
  });

  it("production CSP: same-origin only, framing denied, PDF blob/data allowed", () => {
    const policy = buildContentSecurityPolicy({ nodeEnv: "production", vercelEnv: "production" });
    expect(directive(policy, "default-src")).toEqual(["'self'"]);
    expect(directive(policy, "script-src")).toEqual(["'self'", "'unsafe-inline'"]);
    expect(directive(policy, "connect-src")).toEqual(["'self'"]);
    expect(directive(policy, "img-src")).toEqual(expect.arrayContaining(["blob:", "data:"]));
    expect(directive(policy, "frame-ancestors")).toEqual(["'none'"]);
    expect(directive(policy, "object-src")).toEqual(["'none'"]);
    expect(policy).toContain("upgrade-insecure-requests");
    expect(policy).not.toContain("unsafe-eval");
    expect(policy).not.toContain("vercel.live");
  });

  it("allows the Vercel toolbar on Preview and dev tooling locally", () => {
    const preview = buildContentSecurityPolicy({ nodeEnv: "production", vercelEnv: "preview" });
    expect(directive(preview, "script-src")).toContain("https://vercel.live");
    expect(directive(preview, "frame-src")).toContain("https://vercel.live");
    expect(directive(preview, "frame-ancestors")).toEqual(["'none'"]);

    const dev = buildContentSecurityPolicy({ nodeEnv: "development" });
    expect(directive(dev, "script-src")).toEqual(
      expect.arrayContaining(["'unsafe-eval'", "https://va.vercel-scripts.com"])
    );
    expect(dev).not.toContain("upgrade-insecure-requests");
  });
});
