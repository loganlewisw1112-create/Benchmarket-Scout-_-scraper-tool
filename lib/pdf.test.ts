import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildFilename, sanitizeFilenamePart } from "./pdf";

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
