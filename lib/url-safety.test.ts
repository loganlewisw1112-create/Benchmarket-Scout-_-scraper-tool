import { describe, expect, it } from "vitest";
import { isSafePublicHttpUrl, normalizeHttpUrl } from "./url-safety";

describe("normalizeHttpUrl", () => {
  it("upgrades bare hostnames to https", () => {
    expect(normalizeHttpUrl("example.org")).toBe("https://example.org/");
  });

  it("preserves an explicit http scheme", () => {
    expect(normalizeHttpUrl("http://example.org")).toBe("http://example.org/");
  });

  it("rejects empty input", () => {
    expect(() => normalizeHttpUrl("   ")).toThrow("Empty URL");
  });

  it("rejects non-http(s) protocols", () => {
    expect(() => normalizeHttpUrl("ftp://example.org")).toThrow(
      /Unsupported protocol/
    );
    expect(() => normalizeHttpUrl("file:///etc/passwd")).toThrow(
      /Unsupported protocol/
    );
  });

  it("rejects credentials embedded in the URL", () => {
    expect(() => normalizeHttpUrl("https://user:pass@example.org")).toThrow(
      "Credentials in URL are not allowed"
    );
  });
});

describe("isSafePublicHttpUrl (SSRF guard, offline block cases)", () => {
  // None of these require DNS: literal private IPv4s and blocked hostnames
  // are rejected before any lookup, and the rest deterministically fail.
  const blocked = [
    "http://127.0.0.1",
    "https://127.0.0.1:8080/admin",
    "http://10.0.0.1",
    "http://172.16.0.1",
    "http://192.168.1.1",
    "http://169.254.169.254/latest/meta-data/", // cloud metadata
    "http://100.64.0.1", // CGNAT
    "http://0.0.0.0",
    "http://localhost",
    "http://foo.localhost",
    "http://[::1]",
    "http://metadata.google.internal",
  ];

  for (const url of blocked) {
    it(`blocks ${url}`, async () => {
      await expect(isSafePublicHttpUrl(url)).resolves.toBe(false);
    });
  }

  it("blocks invalid URLs instead of throwing", async () => {
    await expect(isSafePublicHttpUrl("not a url ://")).resolves.toBe(false);
    await expect(isSafePublicHttpUrl("ftp://example.org")).resolves.toBe(false);
  });
});
