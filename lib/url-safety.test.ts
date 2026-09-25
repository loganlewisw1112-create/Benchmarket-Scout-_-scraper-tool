import { describe, expect, it, vi } from "vitest";
import {
  checkPublicHttpUrl,
  createPinnedHttpTarget,
  createPinnedHttpTargetResult,
  isSafePublicHttpUrl,
  normalizeHttpUrl,
  type ResolveHostname,
  UrlSafetyError,
  urlSafetyReasonOf,
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

  // SEC-6: IPv6 ranges that embed an IPv4 target.
  const embeddedIpv4 = [
    "http://[::127.0.0.1]", // IPv4-compatible ::/96
    "http://[::8.8.8.8]", // IPv4-compatible, deprecated even when public
    "http://[::ffff:0:127.0.0.1]", // IPv4-translated ::ffff:0:0:0/96
    "http://[::ffff:0:a9fe:a9fe]", // translated 169.254.169.254
    "http://[::ffff:127.0.0.1]", // IPv4-mapped (already blocked)
  ];

  for (const url of embeddedIpv4) {
    it(`blocks IPv4-embedding IPv6 literal ${url}`, async () => {
      await expect(checkPublicHttpUrl(url)).resolves.toEqual({
        ok: false,
        reason: "private_address",
      });
    });
  }
});

describe("normalizeHttpUrl trailing dots", () => {
  it("strips trailing dots from hostnames", () => {
    expect(normalizeHttpUrl("https://example.org./a")).toBe(
      "https://example.org/a"
    );
    expect(normalizeHttpUrl("example.org..")).toBe("https://example.org/");
  });

  it("rejects a hostname made only of dots", () => {
    expect(() => normalizeHttpUrl("http://./")).toThrow();
  });
});

describe("checkPublicHttpUrl typed reasons (contract 4)", () => {
  const publicResolver: ResolveHostname = async () => [
    { address: "93.184.216.34", family: 4 },
  ];

  it.each([
    ["not a url ://", "invalid_url"],
    ["   ", "invalid_url"],
    ["ftp://example.org", "unsupported_scheme"],
    ["https://user:pass@example.org", "credentials_in_url"],
    ["https://example.org:8443/", "blocked_port"],
    ["http://example.org:22/", "blocked_port"],
    ["http://localhost./", "blocked_host"],
    ["http://metadata.google.internal./", "blocked_host"],
    ["http://127.0.0.1/", "private_address"],
  ] as const)("%s -> %s", async (url, reason) => {
    await expect(checkPublicHttpUrl(url, publicResolver)).resolves.toEqual({
      ok: false,
      reason,
    });
  });

  it.each([
    "https://example.org/",
    "http://example.org/",
    "https://example.org:443/",
    "http://example.org:80/",
    "http://example.org:443/",
    "https://example.org./",
  ])("allows %s on a default web port", async (url) => {
    await expect(checkPublicHttpUrl(url, publicResolver)).resolves.toEqual({
      ok: true,
    });
  });

  it("maps NXDOMAIN to dns_unresolved, not a safety failure", async () => {
    const nxdomain: ResolveHostname = async () => {
      throw Object.assign(new Error("getaddrinfo ENOTFOUND dead.example"), {
        code: "ENOTFOUND",
      });
    };
    await expect(
      checkPublicHttpUrl("https://dead.example", nxdomain)
    ).resolves.toEqual({ ok: false, reason: "dns_unresolved" });

    await expect(
      checkPublicHttpUrl("https://empty.example", async () => [])
    ).resolves.toEqual({ ok: false, reason: "dns_unresolved" });
  });

  it("maps other resolver failures to dns_error", async () => {
    const servfail: ResolveHostname = async () => {
      throw Object.assign(new Error("queryA ESERVFAIL"), { code: "ESERVFAIL" });
    };
    await expect(
      checkPublicHttpUrl("https://flaky.example", servfail)
    ).resolves.toEqual({ ok: false, reason: "dns_error" });
  });

  it("exposes the reason on normalizeHttpUrl errors", () => {
    try {
      normalizeHttpUrl("ftp://example.org");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(UrlSafetyError);
      expect(urlSafetyReasonOf(error)).toBe("unsupported_scheme");
    }
    expect(urlSafetyReasonOf(new Error("other"))).toBe("invalid_url");
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

  it("returns a typed reason from createPinnedHttpTargetResult", async () => {
    const result = await createPinnedHttpTargetResult(
      "https://mixed.example",
      undefined,
      async () => [{ address: "10.0.0.5", family: 4 }]
    );
    expect(result).toEqual({ ok: false, reason: "private_address" });
  });

  it("rejects with the abort reason instead of reporting a safety failure", async () => {
    const controller = new AbortController();
    const resolver = vi.fn<ResolveHostname>(async () => {
      controller.abort(new Error("budget exhausted"));
      return [{ address: "93.184.216.34", family: 4 }];
    });
    await expect(
      createPinnedHttpTargetResult("https://slow.example", controller.signal, resolver)
    ).rejects.toThrow("budget exhausted");

    // The legacy null-returning form still swallows the abort.
    await expect(
      createPinnedHttpTarget("https://slow.example", controller.signal, resolver)
    ).resolves.toBeNull();
  });

  it("pins a trailing-dot hostname and accepts either spelling at connect time", async () => {
    const target = await createPinnedHttpTarget(
      "https://dotted.example./",
      undefined,
      async () => [{ address: "93.184.216.34", family: 4 }]
    );
    expect(target).not.toBeNull();
    if (!target) return;
    expect(target.url).toBe("https://dotted.example/");

    for (const hostname of ["dotted.example", "dotted.example."]) {
      await expect(
        new Promise((resolve, reject) => {
          target.lookup(hostname, { all: false }, (error, address) => {
            if (error) reject(error);
            else resolve(address);
          });
        })
      ).resolves.toBe("93.184.216.34");
    }
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
