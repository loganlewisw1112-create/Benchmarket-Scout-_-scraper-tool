import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:dns", () => {
  const lookup = vi.fn();
  return { default: { promises: { lookup } }, promises: { lookup } };
});

vi.mock("./cache", () => ({
  CACHE_TTL: { geocode: 1000, homepages: 1000, robots: 1000 },
  readCache: vi.fn(async () => null),
  writeCache: vi.fn(async () => {}),
}));

import dns from "node:dns";
import { readFileSync } from "node:fs";
import { auditWebsite, describeUrlSafetyReason } from "./audit";

// Real homepage bodies captured during the production audit (one GET each).
function fixture(name: string): string {
  return readFileSync(new URL(`./__fixtures__/audit/${name}`, import.meta.url), "utf8");
}

const PUBLIC_IP = "93.184.216.34";
const PRIVATE_IP = "10.0.0.5";

function stubDns(address: string) {
  (dns.promises.lookup as ReturnType<typeof vi.fn>).mockResolvedValue([
    { address, family: 4 },
  ]);
}

function htmlResponse(
  html: string,
  opts: { status?: number; contentType?: string; headers?: Record<string, string> } = {}
) {
  const status = opts.status ?? 200;
  const headerMap = new Map(
    Object.entries({ "content-type": opts.contentType ?? "text/html", ...(opts.headers ?? {}) })
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headerMap.get(k.toLowerCase()) ?? null },
    body: {
      getReader: () => {
        const bytes = new TextEncoder().encode(html);
        let sent = false;
        return {
          read: async () => {
            if (sent) return { done: true, value: undefined };
            sent = true;
            return { done: false, value: bytes };
          },
          cancel: () => {},
        };
      },
    },
    text: async () => html,
  } as unknown as Response;
}

function redirectResponse(location: string, status = 301) {
  return {
    ok: false,
    status,
    headers: { get: (k: string) => (k.toLowerCase() === "location" ? location : null) },
  } as unknown as Response;
}

const SAMPLE_HTML = `<!doctype html>
<html><head>
<title>Acme Plumbing | Austin Plumber</title>
<meta name="description" content="Trusted Austin plumbing services.">
<meta name="viewport" content="width=device-width">
</head><body>
<h1>Acme Plumbing</h1>
<p>Call us today or request a free estimate. Licensed, certified, and insured.</p>
<p>Read our testimonials from happy clients.</p>
<p>Family-owned since 1998, we repair leaks, replace water heaters, clear
drains, and install new fixtures for homes and small businesses across the
Austin area, with upfront prices and tidy work.</p>
<a href="/contact">Contact</a>
<a href="/services">Services</a>
<a href="tel:5551234567">555-123-4567</a>
<a href="https://facebook.com/acmeplumbing">Facebook</a>
</body></html>`;

describe("auditWebsite (mocked fetch + dns)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubDns(PUBLIC_IP);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses a homepage and computes audit fields", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(htmlResponse(SAMPLE_HTML)));

    const result = await auditWebsite({
      url: "https://test-target.example",
      businessType: "plumbing",
      market: "Austin, TX",
      sourceId: "S1",
    });

    expect(result.audit.skipped).toBe(false);
    expect(result.audit.auditStatus).toBe("complete");
    expect(result.audit.sourceIds).toEqual(["S1"]);
    expect(result.audit.title).toBe("Acme Plumbing | Austin Plumber");
    expect(result.audit.metaDescription).toContain("Austin plumbing");
    expect(result.audit.h1Count).toBe(1);
    expect(result.audit.hasPhone).toBe(true);
    expect(result.audit.hasContactPage).toBe(true);
    expect(result.audit.hasServicesPage).toBe(true);
    expect(result.audit.hasTestimonials).toBe(true);
    expect(result.audit.hasTrustLanguage).toBe(true);
    expect(result.audit.hasViewport).toBe(true);
    expect(result.audit.isHttps).toBe(true);
    expect(result.audit.socialLinks.facebook).toBe("https://facebook.com/acmeplumbing");
    expect(result.audit.websiteScore).toBeGreaterThan(0);
    expect(result.pageTexts[0].sourceType).toBe("homepage");
    expect(result.pageTexts[0].sourceIds).toEqual(["S1"]);
    expect(Number.isNaN(Date.parse(result.accessedAt))).toBe(false);
  });

  it("follows a redirect and re-validates the destination", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(redirectResponse("https://test-target.example/home"))
      .mockResolvedValue(htmlResponse(SAMPLE_HTML));
    vi.stubGlobal("fetch", fetchMock);

    const result = await auditWebsite({
      url: "https://test-target.example",
      businessType: "plumbing",
      market: "Austin, TX",
      sourceId: "S1",
    });

    expect(result.audit.skipped).toBe(false);
    expect(result.audit.normalizedUrl).toBe("https://test-target.example/home");
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      redirect: "manual",
      dispatcher: expect.anything(),
    });
  });

  it("blocks a redirect hop when DNS changes from public to private", async () => {
    (dns.promises.lookup as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([{ address: PUBLIC_IP, family: 4 }])
      .mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(redirectResponse("https://rebound.example/private"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await auditWebsite({
      url: "https://test-target.example",
      businessType: "plumbing",
      market: "Austin, TX",
      sourceId: "S1",
    });

    expect(result.audit.skipped).toBe(true);
    expect(result.audit.reason).toBe("URL failed public safety check");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(dns.promises.lookup).toHaveBeenCalledTimes(2);
  });

  it("gives up after too many redirects", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => redirectResponse("https://test-target.example/loop"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await auditWebsite({
      url: "https://test-target.example",
      businessType: "plumbing",
      market: "Austin, TX",
      sourceId: "S1",
    });

    expect(result.audit.skipped).toBe(true);
    expect(result.audit.reason).toBe("Too many redirects");
    expect(result.audit.auditStatus).toBe("unavailable");
    expect(result.audit.websiteScore).toBeNull();
    expect(result.audit.scoreBreakdown.seo).toBeNull();
  });

  it("rejects non-HTML content types", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(htmlResponse("{}", { contentType: "application/json" }))
    );

    const result = await auditWebsite({
      url: "https://test-target.example",
      businessType: "plumbing",
      market: "Austin, TX",
      sourceId: "S1",
    });

    expect(result.audit.skipped).toBe(true);
    expect(result.audit.reason).toBe("Non-HTML content type");
  });

  it("rejects responses whose declared Content-Length exceeds the byte cap", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        htmlResponse(SAMPLE_HTML, { headers: { "content-length": String(2 * 1024 * 1024) } })
      )
    );

    const result = await auditWebsite({
      url: "https://test-target.example",
      businessType: "plumbing",
      market: "Austin, TX",
      sourceId: "S1",
    });

    expect(result.audit.skipped).toBe(true);
    expect(result.audit.reason).toBe("Response too large");
  });

  it("skips the audit when the URL fails the SSRF safety check", async () => {
    stubDns(PRIVATE_IP);
    vi.stubGlobal("fetch", vi.fn());

    const result = await auditWebsite({
      url: "https://internal-only.example",
      businessType: "plumbing",
      market: "Austin, TX",
      sourceId: "S1",
    });

    expect(result.audit.skipped).toBe(true);
    expect(result.audit.reason).toBe("URL failed public safety check");
  });

  it("preserves failed selected linked-page attempts with reason and timestamp", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(htmlResponse(SAMPLE_HTML))
      .mockResolvedValueOnce(htmlResponse("", { status: 503 }))
      .mockResolvedValueOnce(htmlResponse(SAMPLE_HTML));
    vi.stubGlobal("fetch", fetchMock);

    const result = await auditWebsite({
      url: "https://test-target.example",
      businessType: "plumbing",
      market: "Austin, TX",
      sourceId: "S1",
    });

    expect(result.audit.auditStatus).toBe("partial");
    expect(result.linkedPageAttempts).toHaveLength(2);
    expect(result.linkedPageAttempts[0]).toMatchObject({
      url: "https://test-target.example/services",
      status: "unavailable",
      reason: "Site returned an HTTP 5xx error",
      reasonCode: "http_error",
    });
    expect(result.linkedPageAttempts[1]).toMatchObject({
      url: "https://test-target.example/contact",
      status: "used",
    });
    expect(
      result.linkedPageAttempts.every(
        (attempt) => !Number.isNaN(Date.parse(attempt.accessedAt))
      )
    ).toBe(true);
  });

  it("returns an unavailable audit immediately when the parent budget is canceled", async () => {
    const controller = new AbortController();
    controller.abort(new Error("request deadline"));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await auditWebsite({
      url: "https://test-target.example",
      businessType: "plumbing",
      market: "Austin, TX",
      sourceId: "S1",
      signal: controller.signal,
      budgetMs: 7_000,
    });

    expect(result.audit).toMatchObject({
      auditStatus: "unavailable",
      skipped: true,
      websiteScore: null,
    });
    expect(result.audit.reason).toMatch(/time budget exhausted/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

const AUDIT_ARGS = {
  url: "https://test-target.example",
  businessType: "plumbing",
  market: "Austin, TX",
  sourceId: "S1" as const,
};

describe("auditWebsite: content-empty pages (contract 5)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubDns(PUBLIC_IP);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fails a JS-only SPA shell as insufficient_content instead of scoring it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(htmlResponse(fixture("supercuts.com.html"))));

    const result = await auditWebsite(AUDIT_ARGS);

    expect(result.audit).toMatchObject({
      auditStatus: "unavailable",
      skipped: true,
      reasonCode: "insufficient_content",
      websiteScore: null,
      wordCount: null,
    });
    expect(result.audit.reason).toMatch(/too little readable page content/i);
    expect(result.pageTexts).toEqual([]);
    expect(result.audit.evidence.map((e) => e.claim).join(" ")).not.toMatch(
      /fetched successfully/
    );
  });

  it("does not follow a meta refresh to another site (drneda.com -> goldnsoul.com)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(htmlResponse(fixture("drneda.com.html")));
    vi.stubGlobal("fetch", fetchMock);

    const result = await auditWebsite({ ...AUDIT_ARGS, url: "http://drneda.com/" });

    expect(result.audit.auditStatus).toBe("unavailable");
    expect(result.audit.reasonCode).toBe("insufficient_content");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not follow a meta refresh to a different domain (parisbaguetteusa.com)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(htmlResponse(fixture("parisbaguetteusa.com.html")));
    vi.stubGlobal("fetch", fetchMock);

    const result = await auditWebsite({ ...AUDIT_ARGS, url: "https://www.parisbaguetteusa.com/" });

    expect(result.audit.reasonCode).toBe("insufficient_content");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("follows a same-site meta refresh once through the safe fetch path", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        htmlResponse(
          `<html><head><meta http-equiv="refresh" content="0; URL='/home/'"></head><body></body></html>`
        )
      )
      .mockResolvedValue(htmlResponse(SAMPLE_HTML));
    vi.stubGlobal("fetch", fetchMock);

    const result = await auditWebsite(AUDIT_ARGS);

    expect(result.audit.auditStatus).not.toBe("unavailable");
    expect(result.audit.normalizedUrl).toBe("https://test-target.example/home/");
    expect(fetchMock.mock.calls[1][0]).toBe("https://test-target.example/home/");
    // The refreshed hop is DNS-pinned like any redirect hop.
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ dispatcher: expect.anything() });
  });

  it("follows a meta refresh only once", async () => {
    const stub = `<html><head><meta http-equiv="refresh" content="0;url=/next"></head><body>Loading</body></html>`;
    const fetchMock = vi.fn().mockResolvedValue(htmlResponse(stub));
    vi.stubGlobal("fetch", fetchMock);

    const result = await auditWebsite(AUDIT_ARGS);

    expect(result.audit.reasonCode).toBe("insufficient_content");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails a near-empty page below the word floor", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        htmlResponse("<html><head><title>BJ's</title></head><body><p>Order now</p></body></html>")
      )
    );

    const result = await auditWebsite(AUDIT_ARGS);

    expect(result.audit.reasonCode).toBe("insufficient_content");
    expect(result.audit.websiteScore).toBeNull();
  });
});

describe("auditWebsite: failure reasons (contract 4, SEC-6)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubDns(PUBLIC_IP);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports a dead domain as 'Domain does not resolve', not a safety failure", async () => {
    (dns.promises.lookup as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error("getaddrinfo ENOTFOUND grandgoldenbay-seafood.com"), {
        code: "ENOTFOUND",
      })
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await auditWebsite({ ...AUDIT_ARGS, url: "https://grandgoldenbay-seafood.com" });

    expect(result.audit.reason).toBe("Domain does not resolve");
    expect(result.audit.reasonCode).toBe("dns_unresolved");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps every url-safety reason to user-facing text", () => {
    expect(describeUrlSafetyReason("dns_unresolved")).toBe("Domain does not resolve");
    expect(describeUrlSafetyReason("dns_error")).toBe("Domain lookup failed");
    expect(describeUrlSafetyReason("invalid_url")).toBe("Invalid URL");
    for (const reason of [
      "unsupported_scheme",
      "credentials_in_url",
      "blocked_port",
      "blocked_host",
      "private_address",
    ] as const) {
      expect(describeUrlSafetyReason(reason)).toBe("URL failed public safety check");
    }
  });

  it.each([
    [403, "blocked_by_site", "Site refused automated access"],
    [429, "blocked_by_site", "Site refused automated access"],
    [404, "http_error", "Site returned an HTTP 4xx error"],
    [502, "http_error", "Site returned an HTTP 5xx error"],
  ])("collapses HTTP %i into %s without the raw status", async (status, code, reason) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(htmlResponse("", { status })));

    const result = await auditWebsite(AUDIT_ARGS);

    expect(result.audit.reasonCode).toBe(code);
    expect(result.audit.reason).toBe(reason);
    expect(result.audit.reason).not.toContain(String(status));
  });

  it.each([
    ["ECONNREFUSED", "connection_failed", "Could not connect to the site"],
    ["CERT_HAS_EXPIRED", "tls_error", "Secure connection (TLS) failed"],
    ["UND_ERR_CONNECT_TIMEOUT", "timeout", "Audit time budget exhausted"],
  ])("never stores the raw fetch error string (%s)", async (causeCode, code, reason) => {
    const raw = new TypeError("fetch failed", {
      cause: Object.assign(new Error(`connect ${causeCode} 93.184.216.34:443`), {
        code: causeCode,
      }),
    });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(raw));

    const result = await auditWebsite(AUDIT_ARGS);

    expect(result.audit.reasonCode).toBe(code);
    expect(result.audit.reason).toBe(reason);
    expect(JSON.stringify(result)).not.toContain("93.184.216.34");
    expect(JSON.stringify(result)).not.toContain("fetch failed");
  });
});

describe("auditWebsite: decoding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubDns(PUBLIC_IP);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function bytesResponse(bytes: Uint8Array, contentType: string) {
    return {
      ok: true,
      status: 200,
      headers: {
        get: (k: string) => (k.toLowerCase() === "content-type" ? contentType : null),
      },
      body: {
        getReader: () => {
          let sent = false;
          return {
            read: async () => {
              if (sent) return { done: true, value: undefined };
              sent = true;
              return { done: false, value: bytes };
            },
            cancel: () => {},
          };
        },
      },
    } as unknown as Response;
  }

  // Single-byte encoding: "é" becomes the byte 0xE9, which is invalid UTF-8.
  function latin1Bytes(text: string): Uint8Array {
    return Uint8Array.from(text, (ch) => ch.charCodeAt(0));
  }

  it("decodes using the Content-Type charset", async () => {
    const html = SAMPLE_HTML.replace("Acme Plumbing | Austin Plumber", "Café René");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(bytesResponse(latin1Bytes(html), "text/html; charset=windows-1252"))
    );

    const result = await auditWebsite(AUDIT_ARGS);

    expect(result.audit.title).toBe("Café René");
  });

  it("falls back to a <meta charset> when the header names none", async () => {
    const html = SAMPLE_HTML.replace("<head>", '<head><meta charset="iso-8859-1">').replace(
      "Acme Plumbing | Austin Plumber",
      "Café René"
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(bytesResponse(latin1Bytes(html), "text/html")));

    const result = await auditWebsite(AUDIT_ARGS);

    expect(result.audit.title).toBe("Café René");
  });

  it("accepts application/xhtml+xml", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        htmlResponse(SAMPLE_HTML, { contentType: "application/xhtml+xml; charset=utf-8" })
      )
    );

    const result = await auditWebsite(AUDIT_ARGS);

    expect(result.audit.skipped).toBe(false);
    expect(result.audit.title).toBe("Acme Plumbing | Austin Plumber");
  });
});

describe("auditWebsite: link and signal extraction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubDns(PUBLIC_IP);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not treat a WordPress credit as a blog (oaklandvet.com capture)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(htmlResponse(fixture("oaklandvet.com.html"))));

    const result = await auditWebsite({
      ...AUDIT_ARGS,
      url: "https://oaklandvet.com/",
      businessType: "veterinary",
      market: "Oakland, CA",
    });

    expect(result.audit.skipped).toBe(false);
    const credit = result.audit.extractedLinks.find((l) => l.href === "http://wordpress.org/");
    expect(credit?.type).toBe("other");
    expect(result.audit.hasBlogOrNewsPage).toBe(false);
  });

  it("drops non-http(s) links and keeps share buttons out of social profiles", async () => {
    const html = SAMPLE_HTML.replace(
      "</body>",
      `<a href="javascript:alert(1)">Menu</a>
<a href="data:text/html,hi">Data</a>
<a href="https://www.facebook.com/sharer/sharer.php?u=https%3A%2F%2Ftest-target.example">Share</a>
<a href="https://www.facebook.com/dialog/feed?app_id=1">Share</a>
<a href="https://twitter.com/intent/tweet?text=hi">Tweet</a>
<a href="https://twitter.com/share?via=TWITTER_HANDLE">Tweet</a>
<a href="https://www.linkedin.com/shareArticle?mini=true">Share</a>
<a href="https://www.wix.com/">Made with Wix</a>
</body>`
    ).replace('<a href="https://facebook.com/acmeplumbing">Facebook</a>', "");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(htmlResponse(html)));

    const result = await auditWebsite(AUDIT_ARGS);

    expect(result.audit.extractedLinks.every((l) => /^https?:\/\//.test(l.href))).toBe(true);
    expect(result.audit.extractedLinks.some((l) => l.label === "Menu")).toBe(false);
    expect(result.audit.socialLinks).toEqual({});
    expect(result.audit.hasSocialLinks).toBe(false);
  });

  it("does not count 'Facebook' as a CTA or 'preview' as a testimonial", async () => {
    const words = "Plumbing repair and drain care for local homes ".repeat(6);
    const html = `<html><head><title>T</title></head><body>
<h1>Acme</h1><p>${words}</p>
<p>Preview our work. Locally owned. Search results.</p>
<a href="https://www.facebook.com/acme">Facebook</a>
<a href="/bookkeeping">Bookkeeping</a>
<p>Uninsured drivers welcome.</p>
</body></html>`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(htmlResponse(html)));

    const result = await auditWebsite(AUDIT_ARGS);

    expect(result.audit.ctaCount).toBe(0);
    expect(result.audit.hasTestimonials).toBe(false);
    expect(result.audit.hasTrustLanguage).toBe(false);
    expect(result.audit.hasBookingOrQuote).toBe(false);
  });

  it("keeps nav, header, footer and aside words out of signal text", async () => {
    const words = "We fix leaking pipes and clogged drains for families ".repeat(6);
    const html = `<html><body>
<header><a href="/careers">Careers</a> <a href="/about/leadership">Leadership</a></header>
<nav><ul><li>Home</li><li>Now Hiring</li></ul></nav>
<main><h1>Acme</h1><p>${words}</p>
<article><header><h2>Grand opening</h2></header><p>Our new shop opens soon.</p></article></main>
<aside>Temporarily closed on holidays</aside>
<footer>Under new management notice</footer>
</body></html>`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(htmlResponse(html)));

    const result = await auditWebsite(AUDIT_ARGS);

    const text = result.pageTexts[0].text;
    expect(text).toContain("We fix leaking pipes");
    // An article's own header is page content, not site chrome.
    expect(text).toContain("Grand opening");
    expect(text).not.toMatch(/careers|leadership|now hiring|temporarily closed|new management/i);
    expect(result.audit.hasCareersPage).toBe(true);
  });

  it("separates block elements so words are counted, not glued together", async () => {
    const items = Array.from({ length: 45 }, (_, i) => `<li>Item${i}</li>`).join("");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(htmlResponse(`<html><body><ul>${items}</ul></body></html>`))
    );

    const result = await auditWebsite(AUDIT_ARGS);

    expect(result.audit.wordCount).toBe(45);
  });

  it("ignores tel:/mailto: text inside scripts", async () => {
    const words = "Plumbing repair and drain care for local homes ".repeat(6);
    const html = `<html><body><p>${words}</p>
<script>var s = "tel:5551234567 mailto:x@example.com 555-123-4567";</script></body></html>`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(htmlResponse(html)));

    const result = await auditWebsite(AUDIT_ARGS);

    expect(result.audit.hasPhone).toBe(false);
    expect(result.audit.hasEmail).toBe(false);
  });
});

describe("auditWebsite: robots.txt (STRICT_ROBOTS)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubDns(PUBLIC_IP);
    process.env.STRICT_ROBOTS = "true";
  });

  afterEach(() => {
    delete process.env.STRICT_ROBOTS;
    vi.unstubAllGlobals();
  });

  function isRobots(input: unknown): boolean {
    return String(input).endsWith("/robots.txt");
  }

  it("does not count robots.txt latency toward the fetch-speed metric", async () => {
    const fetchMock = vi.fn(async (input: unknown) => {
      if (isRobots(input)) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        return new Response("not found", { status: 404 });
      }
      return htmlResponse(SAMPLE_HTML);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await auditWebsite({ ...AUDIT_ARGS, budgetMs: 10_000 });

    expect(result.audit.skipped).toBe(false);
    expect(fetchMock.mock.calls.some(([input]) => isRobots(input))).toBe(true);
    expect(result.audit.fetchMs).not.toBeNull();
    expect(result.audit.fetchMs!).toBeLessThan(400);
  });

  it("fails open when robots.txt hangs, without consuming the page budget", async () => {
    const fetchMock = vi.fn((input: unknown, init?: RequestInit) => {
      if (isRobots(input)) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), {
            once: true,
          });
        });
      }
      return Promise.resolve(htmlResponse(SAMPLE_HTML));
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await auditWebsite({ ...AUDIT_ARGS, budgetMs: 15_000 });

    expect(result.audit.skipped).toBe(false);
    expect(result.audit.fetchMs!).toBeLessThan(1_000);
  }, 15_000);

  it("fails open when the robots.txt fetch errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        if (isRobots(input)) throw new TypeError("fetch failed");
        return htmlResponse(SAMPLE_HTML);
      })
    );

    const result = await auditWebsite(AUDIT_ARGS);

    expect(result.audit.skipped).toBe(false);
  });

  it("still honors an explicit disallow", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        if (isRobots(input)) {
          return new Response("User-agent: *\nDisallow: /\n", {
            status: 200,
            headers: { "content-type": "text/plain" },
          });
        }
        return htmlResponse(SAMPLE_HTML);
      })
    );

    const result = await auditWebsite(AUDIT_ARGS);

    expect(result.audit.reasonCode).toBe("robots_disallowed");
    expect(result.audit.reason).toBe("Disallowed by robots.txt");
  });
});
