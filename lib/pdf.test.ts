import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAttributionLines,
  buildBenchmarkPdf,
  buildFilename,
  buildSourcesAppendixRows,
  collectPdfText,
  formatPdfMetric,
  formatPdfSourceMarkers,
  formatSourceUrl,
  linkableSourceUrl,
  PDF_TABLE_PAGINATION,
  sanitizeFilenamePart,
} from "./pdf";
import type { UnicodeFontData } from "./pdf-text";
import type { AnalyzeMarketResponse, SourceReference } from "./types";

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
  it("keeps table rows intact and repeats headers across PDF pages", () => {
    expect(PDF_TABLE_PAGINATION).toEqual({
      pageBreak: "auto",
      rowPageBreak: "avoid",
      showHead: "everyPage",
    });
  });

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
        // Readable domain text; the full URL is attached as a cell link.
        "example.org",
        "2026-07-19T08:00:01.000Z",
        "limited",
      ],
    ]);
  });
});

// Only the fields the PDF reads. Cast rather than build a full response so
// this test does not churn with unrelated pipeline type changes.
function pdfFixture(
  overrides: {
    businessName?: string;
    market?: string;
    sources?: SourceReference[];
  } = {}
): AnalyzeMarketResponse {
  const signals = {
    momentumSignals: [],
    offerSignals: [],
    riskSignals: [],
    hiringSignals: [],
    newsSignals: [],
    changeSignals: [],
    momentumScore: null,
    riskScore: null,
  };
  const entity = (
    name: string,
    source: "user" | "competitor",
    rank: number | null
  ) => ({
    name,
    source,
    rank,
    finalScore: rank === null ? null : 60,
    websiteAudit: { websiteScore: 55 },
    signals,
  });
  const businessName = overrides.businessName ?? "Acme Plumbing";
  return {
    generatedAt: "2026-07-19T10:00:00.000Z",
    input: {
      businessName,
      businessUrl: "https://acme.example/",
      businessType: "plumber",
      market: overrides.market ?? "Austin, TX",
    },
    dataQuality: { coverageStatus: "complete" },
    user: entity(businessName, "user", 1),
    competitors: [entity("Rival Pipes", "competitor", 2)],
    summary: {
      competitorAverageFinalScore: 50,
      competitorAverageWebsiteScore: 48,
      marketGap: 10,
      yourRank: 1,
      auditedCompetitorCount: 1,
      status: "leading",
    },
    report: {
      executiveSummary: "Acme Plumbing leads one audited competitor.",
      topFindings: [
        {
          title: "Clear contact path",
          confidence: "high",
          finding: "The homepage exposes a phone number.",
          sourceIds: ["S3"],
        },
      ],
      topRisks: [],
      actionPlan: [
        {
          priority: "medium",
          title: "Add a quote form",
          action: "Add a quote form.",
          sourceIds: ["S3"],
        },
      ],
      methodologyNote: "Scores come from public homepage audits.",
      dataQualityNote: "All sources resolved.",
    },
    provenance: {
      policy: "real-only",
      containsSyntheticData: false,
      sources: overrides.sources ?? [
        {
          id: "S1",
          kind: "nominatim",
          provider: "OpenStreetMap Nominatim",
          title: "Austin, Texas",
          url: "https://nominatim.openstreetmap.org/search?q=Austin",
          accessedAt: "2026-07-19T10:00:00.000Z",
          status: "used",
        },
        {
          id: "S2",
          kind: "openstreetmap",
          provider: "OpenStreetMap Overpass",
          title: "plumber businesses near Austin",
          url: "https://overpass-api.de/api/interpreter",
          accessedAt: "2026-07-19T10:00:01.000Z",
          status: "used",
        },
        {
          id: "S3",
          kind: "homepage",
          provider: "Public business website",
          title: "Acme homepage",
          url: "https://acme.example/",
          accessedAt: "2026-07-19T10:00:02.000Z",
          status: "used",
        },
      ],
    },
  } as unknown as AnalyzeMarketResponse;
}

async function loadVendoredFont(): Promise<UnicodeFontData> {
  const dir = path.join(process.cwd(), "public", "fonts");
  const [normal, bold] = await Promise.all([
    fs.readFile(path.join(dir, "NotoSans-Regular.ttf")),
    fs.readFile(path.join(dir, "NotoSans-Bold.ttf")),
  ]);
  return { normal: normal.toString("binary"), bold: bold.toString("binary") };
}

describe("source citation formatting", () => {
  it("flags the bare Overpass endpoint as a POST query, not a link", () => {
    expect(formatSourceUrl("https://overpass-api.de/api/interpreter")).toBe(
      "https://overpass-api.de/api/interpreter (queried by POST; not a direct link)"
    );
    expect(formatSourceUrl(undefined)).toBe("N/A");
  });

  // frontend-3: the PDF no longer prints raw percent-encoded query strings
  // that wrap mid-escape; it prints the same readable text as the screen and
  // links the cell to the full URL.
  it("prints a readable domain + decoded path and links the full URL", () => {
    expect(formatSourceUrl("https://example.org/page")).toBe("example.org/page");
    const gdelt =
      "https://api.gdeltproject.org/api/v2/doc/doc?query=%22Absolute%20Air%20Solutions%22&mode=ArtList";
    const text = formatSourceUrl(gdelt);
    expect(text).toContain('api.gdeltproject.org/api/v2/doc/doc?query="Absolute Air Solutions"');
    expect(text).not.toContain("%22");
    expect(linkableSourceUrl(gdelt)).toBe(gdelt);
    expect(linkableSourceUrl("https://overpass-api.de/api/interpreter")).toBeUndefined();
    expect(linkableSourceUrl("javascript:alert(1)")).toBeUndefined();
    expect(linkableSourceUrl(undefined)).toBeUndefined();
  });

  it("prints the OSM/ODbL notice only when OSM data was used, plus a provider list", () => {
    const withOsm = buildAttributionLines(pdfFixture().provenance.sources);
    expect(withOsm[0]).toContain("© OpenStreetMap contributors");
    expect(withOsm[0]).toContain("https://www.openstreetmap.org/copyright");
    expect(withOsm[1]).toBe(
      "Providers cited in this report: OpenStreetMap Nominatim (1 source); OpenStreetMap Overpass (1 source); Public business website (1 source)."
    );

    const noOsm = buildAttributionLines([
      {
        id: "S1",
        kind: "homepage",
        provider: "Public business website",
        title: "Home",
        accessedAt: "2026-07-19T10:00:00.000Z",
        status: "used",
      },
    ]);
    expect(noOsm.join(" ")).not.toContain("OpenStreetMap");
  });

  it("folds accents in filenames instead of dropping the letters", () => {
    expect(sanitizeFilenamePart("Phở Hà Nội")).toBe("pho-ha-noi");
    expect(sanitizeFilenamePart("河内粉店")).toBe("");
  });
});

describe("buildBenchmarkPdf", () => {
  it("matches the screen: shared ranks, position-derived status, and the empty-plan note", async () => {
    const data = pdfFixture();
    Object.assign(data.user, { rankTied: true });
    Object.assign(data.competitors[0], { rank: 1, rankTied: true });
    // A stored v1 summary whose status contradicts rank/gap is recomputed.
    Object.assign(data.summary, { status: "behind but recoverable", marketGap: 0 });
    Object.assign(data.report, {
      actionPlan: [],
      actionPlanNote: "No material gaps found: your homepage audit showed every element this report checks.",
    });

    const text = collectPdfText(data).join(" | ");
    expect(text).toContain("tied for #1 of 2");
    expect(text).not.toContain("behind but recoverable");
    expect(text).toContain("No material gaps found");

    const output = (await buildBenchmarkPdf(data, { loadFont: vi.fn() })).doc.output();
    expect(output).toContain("No material gaps found");
    // The readable Sources Appendix cell links to the full homepage URL.
    expect(output).toContain("/URI (https://acme.example/)");
  });

  it("uses built-in Helvetica for WinAnsi text and prints the OSM attribution", async () => {
    const loadFont = vi.fn();
    const built = await buildBenchmarkPdf(pdfFixture(), { loadFont });

    expect(loadFont).not.toHaveBeenCalled();
    expect(built.fontFamily).toBe("helvetica");
    expect(built.replacedCharacters).toBe(0);
    const output = built.doc.output();
    expect(output).toContain("OpenStreetMap contributors");
    expect(output).toContain("Data Sources and Attribution");
    expect(output).toContain("Sources Appendix");
    expect(output).not.toContain("could not be rendered");
  });

  it("embeds Noto Sans for Vietnamese names so nothing is replaced", async () => {
    const loadFont = vi.fn(loadVendoredFont);
    const built = await buildBenchmarkPdf(
      pdfFixture({
        businessName: "Phở Hà Nội Ünïcödé Café",
      }),
      { loadFont }
    );

    expect(loadFont).toHaveBeenCalledTimes(1);
    expect(built.fontFamily).toBe("NotoSans");
    expect(built.replacedCharacters).toBe(0);
    expect(built.doc.output()).toContain("NotoSans");
  });

  it("marks characters the embedded font lacks (CJK) instead of garbling them", async () => {
    const built = await buildBenchmarkPdf(
      pdfFixture({ businessName: "Phở 河内粉店" }),
      { loadFont: loadVendoredFont }
    );

    expect(built.fontFamily).toBe("NotoSans");
    // Four CJK characters, printed at least once (header and table).
    expect(built.replacedCharacters).toBeGreaterThanOrEqual(4);
  });

  it("falls back to Helvetica with a visible notice when the font cannot load", async () => {
    const built = await buildBenchmarkPdf(
      pdfFixture({ businessName: "Phở Hà Nội" }),
      { loadFont: async () => null }
    );

    expect(built.fontFamily).toBe("helvetica");
    expect(built.replacedCharacters).toBeGreaterThan(0);
    expect(built.doc.output()).toContain("could not be rendered in this PDF");
  });

  it("wraps a long business type and market across header lines", async () => {
    const longMarket = "A Very Long Market Name Somewhere Far Away ".repeat(3).trim();
    const built = await buildBenchmarkPdf(pdfFixture({ market: longMarket }), {
      loadFont: async () => null,
    });
    const output = built.doc.output();

    // Unwrapped, the header would be one text run containing the full market.
    expect(output).not.toContain(longMarket);
    expect(output).toContain("A Very Long Market Name");
  });
});
