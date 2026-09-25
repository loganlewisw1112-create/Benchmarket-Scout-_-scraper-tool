import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const headerState = { ip: "203.0.113.9" };

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": headerState.ip }),
}));

vi.mock("@/lib/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/store")>()),
  readReportV2: vi.fn(async () => ({ status: "legacy" })),
}));

import SharedReportPage, { generateMetadata } from "@/app/r/[id]/page";
import { GUARD_BUCKET_LIMITS } from "./api-guard";

const params = Promise.resolve({ id: "abcdef123456" });

function componentName(element: unknown): string {
  const type = (element as { type?: { name?: string } }).type;
  return type?.name ?? "";
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Math.floor(1_770_001_000_000 / 60_000) * 60_000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("/r/[id] page rate limit", () => {
  it("serves the page until the per-IP 'reports' bucket is spent, then a noindex notice", async () => {
    headerState.ip = "203.0.113.9";
    for (let i = 0; i < GUARD_BUCKET_LIMITS.reports; i++) {
      expect(componentName(await SharedReportPage({ params }))).toBe(
        "LegacyReportUnavailable"
      );
    }
    expect(componentName(await SharedReportPage({ params }))).toBe("RateLimitedReport");
    const meta = await generateMetadata({ params });
    expect(meta.title).toContain("Too many requests");
    expect(meta.robots).toEqual({ index: false, follow: false });

    headerState.ip = "203.0.113.10";
    expect(componentName(await SharedReportPage({ params }))).toBe(
      "LegacyReportUnavailable"
    );
  });

  it("404s a malformed id before spending the rate-limit bucket", async () => {
    headerState.ip = "203.0.113.77";
    const bad = Promise.resolve({ id: "no" });
    for (let i = 0; i < GUARD_BUCKET_LIMITS.reports + 5; i++) {
      await expect(SharedReportPage({ params: bad })).rejects.toThrow();
    }
    const meta = await generateMetadata({ params: bad });
    expect(meta.title).toBe("Report not found");
    // The bucket was never touched, so a valid id still renders.
    expect(componentName(await SharedReportPage({ params }))).toBe(
      "LegacyReportUnavailable"
    );
  });

  it("keeps the OG image on unavailable reports", async () => {
    headerState.ip = "198.51.100.77";
    const meta = await generateMetadata({ params });
    expect(meta.openGraph?.images).toEqual([
      expect.objectContaining({ url: "/opengraph-image.png" }),
    ]);
    expect(meta.alternates?.canonical).toBe("/r/abcdef123456");
  });
});

describe("/r/[id] page header date", () => {
  function collectText(node: unknown, out: string[] = []): string[] {
    if (node === null || node === undefined || typeof node === "boolean") return out;
    if (typeof node === "string" || typeof node === "number") {
      out.push(String(node));
      return out;
    }
    if (Array.isArray(node)) {
      for (const child of node) collectText(child, out);
      return out;
    }
    const props = (node as { props?: Record<string, unknown> }).props;
    if (props?.dateTime) out.push(`[time ${String(props.dateTime)}]`);
    if (props && "children" in props) collectText(props.children, out);
    return out;
  }

  it("shows the analysis generatedAt, not the newer stored createdAt, and labels a cache hit", async () => {
    headerState.ip = "192.0.2.44";
    const { readReportV2 } = await import("@/lib/store");
    vi.mocked(readReportV2).mockResolvedValueOnce({
      status: "ok",
      value: {
        createdAt: "2026-09-20T12:00:00.000Z",
        report: {
          input: { businessName: "Acme", market: "Austin, TX" },
          market: { label: "Austin, Texas" },
          generatedAt: "2026-09-18T08:00:00.000Z",
          dataQuality: { cacheHit: true },
        },
      },
    } as never);

    const text = collectText(await SharedReportPage({ params })).join("");
    expect(text).toContain("[time 2026-09-18T08:00:00.000Z]");
    expect(text).not.toContain("2026-09-20T12:00:00.000Z");
    expect(text).toContain("(cached analysis)");
  });
});
