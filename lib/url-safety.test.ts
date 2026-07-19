import { describe, expect, it, vi } from "vitest";
import {
  createPinnedHttpTarget,
  isSafePublicHttpUrl,
  normalizeHttpUrl,
  type ResolveHostname,
} from "./url-safety";

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
    "http://[fe90::1]",
    "http://[fc00::1]",
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

describe("createPinnedHttpTarget", () => {
  it("rejects a hostname if any DNS answer is private or link-local", async () => {
    const mixedResolver = vi.fn<ResolveHostname>(async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "169.254.169.254", family: 4 },
    ]);

    await expect(
      createPinnedHttpTarget("https://mixed.example", undefined, mixedResolver)
    ).resolves.toBeNull();
  });

  it("pins the connector to the validated answer instead of re-resolving", async () => {
    const resolver = vi
      .fn<ResolveHostname>()
      .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
      // A second system resolution would be a DNS-rebinding result. The
      // pinned connector must never ask for it.
      .mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);

    const target = await createPinnedHttpTarget(
      "https://rebind.example/report",
      undefined,
      resolver
    );
    expect(target).not.toBeNull();
    if (!target) return;

    const connectedAddress = await new Promise<{
      address: string;
      family?: number;
    }>((resolve, reject) => {
      target.lookup("rebind.example", { all: false }, (error, address, family) => {
        if (error) {
          reject(error);
          return;
        }
        if (typeof address !== "string") {
          reject(new Error("Expected one pinned address"));
          return;
        }
        resolve({ address, family });
      });
    });

    expect(connectedAddress).toEqual({
      address: "93.184.216.34",
      family: 4,
    });
    expect(resolver).toHaveBeenCalledTimes(1);
    await target.close();
  });

  it("refuses to use a pinned dispatcher for another hostname", async () => {
    const target = await createPinnedHttpTarget(
      "https://safe.example",
      undefined,
      async () => [{ address: "93.184.216.34", family: 4 }]
    );
    expect(target).not.toBeNull();
    if (!target) return;

    await expect(
      new Promise((resolve, reject) => {
        target.lookup("redirected.example", { all: false }, (error, address) => {
          if (error) reject(error);
          else resolve(address);
        });
      })
    ).rejects.toMatchObject({ code: "ENOTFOUND" });
    await target.close();
  });
});
