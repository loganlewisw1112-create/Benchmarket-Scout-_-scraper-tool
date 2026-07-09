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
import { auditWebsite } from "./audit";

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
    });

    expect(result.audit.skipped).toBe(false);
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
    });

    expect(result.audit.skipped).toBe(false);
    expect(result.audit.normalizedUrl).toBe("https://test-target.example/home");
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
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
    });

    expect(result.audit.skipped).toBe(true);
    expect(result.audit.reason).toBe("Too many redirects");
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
    });

    expect(result.audit.skipped).toBe(true);
    expect(result.audit.reason).toBe("URL failed public safety check");
  });
});
