import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildFilename,
  buildSourcesAppendixRows,
  formatPdfMetric,
  formatPdfSourceMarkers,
  sanitizeFilenamePart,
} from "./pdf";

describe("sanitizeFilenamePart", () => {
  it("lowercases and converts spaces to hyphens", () => {
    expect(sanitizeFilenamePart("Acme Plumbing Co")).toBe("acme-plumbing-co");
  });

  it("strips special characters", () => {
    expect(sanitizeFilenamePart("Joe's Plumbing & Sons!")).toBe("joes-plumbing-sons");
  });

  it("collapses consecutive hyphens", () => {
    expect(sanitizeFilenamePart("Austin,   TX")).toBe("austin-tx");
  });

  it("trims leading/trailing whitespace before processing", () => {
    expect(sanitizeFilenamePart("  Acme  ")).toBe("acme");
  });
});

describe("buildFilename", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-09T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("builds a filename with sanitized parts and today's date", () => {
    expect(buildFilename("Acme Plumbing", "Austin, TX")).toBe(
      "benchmark-scout-acme-plumbing-austin-tx-2026-07-09.pdf"
    );
  });

  it("truncates filenames longer than 100 characters to 96 chars + .pdf", () => {
    const longName = "A".repeat(80);
    const filename = buildFilename(longName, "Austin, TX");

    expect(filename.length).toBe(100);
    expect(filename.endsWith(".pdf")).toBe(true);
    expect(filename.slice(0, 96)).toBe(
      `benchmark-scout-${longName.toLowerCase()}-austin-tx-2026-07-09`.slice(0, 96)
    );
  });
});

describe("real-only report formatting", () => {
  it("renders nullable and signed metrics without leaking null", () => {
    expect(formatPdfMetric(null, { suffix: "/100" })).toBe("N/A");
    expect(formatPdfMetric(0, { signed: true })).toBe("+0");
    expect(formatPdfMetric(-4, { signed: true })).toBe("-4");
  });

  it("formats stable source citation markers", () => {
    expect(formatPdfSourceMarkers(["S1", "S3"])).toBe("[S1] [S3]");
    expect(formatPdfSourceMarkers([])).toBe("");
  });

  it("includes every provenance field in source appendix rows", () => {
    const rows = buildSourcesAppendixRows([
      {
        id: "S1",
        kind: "user_input",
        provider: "Submitted request",
        title: "Submitted business",
        accessedAt: "2026-07-19T08:00:00.000Z",
        status: "used",
      },
      {
        id: "S2",
        kind: "homepage",
        provider: "Public website",
        title: "Business homepage",
        url: "https://example.org/",
        accessedAt: "2026-07-19T08:00:01.000Z",
        status: "limited",
      },
    ]);

    expect(rows).toEqual([
      [
        "[S1]",
        "Submitted request",
        "Submitted business",
        "N/A",
        "2026-07-19T08:00:00.000Z",
        "used",
      ],
      [
        "[S2]",
        "Public website",
        "Business homepage",
        "https://example.org/",
        "2026-07-19T08:00:01.000Z",
        "limited",
      ],
    ]);
  });
});
