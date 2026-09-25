// jsPDF and jspdf-autotable are loaded with dynamic import() inside
// buildBenchmarkPdf, so the ~150 KB (brotli) PDF toolchain only downloads when
// someone clicks "Download PDF". Only types are imported statically.
import type { jsPDF } from "jspdf";
import {
  createPdfTextSanitizer,
  loadUnicodeFont,
  needsUnicodeFont,
  UNICODE_FONT_FAMILY,
  UNRENDERABLE_PLACEHOLDER,
  type PdfFontFamily,
  type PdfTextSanitizer,
  type UnicodeFontData,
} from "./pdf-text";
import { displayStatusForSummary, formatRank } from "./scoring";
import { OSM_ATTRIBUTION, OSM_COPYRIGHT_URL } from "./site";
import { describeSourceUrl } from "./source-url";
import type {
  AnalyzeMarketResponse,
  SourceId,
  SourceReference,
} from "./types";

const PAGE_WIDTH = 210;
const MARGIN = 14;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

export const PDF_TABLE_PAGINATION = {
  pageBreak: "auto",
  rowPageBreak: "avoid",
  showHead: "everyPage",
} as const;

export const PDF_DISCLAIMER =
  "Real public-source benchmark. Not verified internal company data.";
export const PDF_OSM_NOTICE = `${OSM_ATTRIBUTION} (${OSM_COPYRIGHT_URL.replace("https://www.", "")})`;
export const PDF_UNRENDERABLE_NOTICE = `Some characters could not be rendered in this PDF and appear as "${UNRENDERABLE_PLACEHOLDER}". The online report shows the original text.`;

export function formatPdfMetric(
  value: number | null,
  options?: { signed?: boolean; suffix?: string }
): string {
  if (value === null) return "N/A";
  const prefix = options?.signed && value >= 0 ? "+" : "";
  return `${prefix}${value}${options?.suffix ?? ""}`;
}

export function formatPdfSourceMarkers(sourceIds: readonly SourceId[]): string {
  return sourceIds.map((sourceId) => `[${sourceId}]`).join(" ");
}

// Readable citation text, the same as the on-screen Sources Appendix: the
// domain plus a decoded, shortened path/query instead of a raw percent-encoded
// string that wraps mid-escape (frontend-3). The full URL is attached to the
// cell as a link (see linkableSourceUrl). The Overpass API is queried by POST,
// so its bare interpreter endpoint is not a link anyone can open (a GET
// returns 406); say so rather than presenting it as a reproducible citation.
export function formatSourceUrl(url: string | undefined): string {
  if (!url) return "N/A";
  const parsed = httpUrl(url);
  if (!parsed) return url;
  const { domain, detail, linkable } = describeSourceUrl(parsed.toString());
  if (!linkable) return `${url} (queried by POST; not a direct link)`;
  return `${domain}${detail}`;
}

/** The full URL to attach to a Sources Appendix cell, when it is openable. */
export function linkableSourceUrl(url: string | undefined): string | undefined {
  const parsed = url ? httpUrl(url) : undefined;
  if (!parsed) return undefined;
  return describeSourceUrl(parsed.toString()).linkable ? parsed.toString() : undefined;
}

function httpUrl(url: string): URL | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

export function buildSourcesAppendixRows(
  sources: readonly SourceReference[]
): string[][] {
  return sources.map((source) => [
    `[${source.id}]`,
    source.provider,
    source.businessName
      ? `${source.businessName}${source.title !== source.businessName ? ` — ${source.title}` : ""}`
      : source.title,
    formatSourceUrl(source.url),
    source.accessedAt,
    source.status,
  ]);
}

export function usesOpenStreetMapData(sources: readonly SourceReference[]): boolean {
  return sources.some(
    (source) => source.kind === "nominatim" || source.kind === "openstreetmap"
  );
}

// "Data sources and attribution" section: the ODbL notice when OSM-derived
// data is present, then each provider with how many cited sources it backs.
export function buildAttributionLines(
  sources: readonly SourceReference[]
): string[] {
  const lines: string[] = [];
  if (usesOpenStreetMapData(sources)) {
    lines.push(
      `${OSM_ATTRIBUTION}. Market geocoding (Nominatim) and competitor discovery (Overpass API) use OpenStreetMap data, available under the Open Database License (ODbL): ${OSM_COPYRIGHT_URL}`
    );
  }
  const counts = new Map<string, number>();
  for (const source of sources) {
    counts.set(source.provider, (counts.get(source.provider) ?? 0) + 1);
  }
  if (counts.size > 0) {
    const providers = [...counts.entries()]
      .map(([provider, n]) => `${provider} (${n} source${n === 1 ? "" : "s"})`)
      .join("; ");
    lines.push(`Providers cited in this report: ${providers}.`);
  }
  lines.push(
    "Every [S#] marker in this document refers to a row in the Sources Appendix below."
  );
  return lines;
}

// Folds characters without an ASCII form (accents) to their base letter so
// "Phở Hà Nội" becomes "pho-ha-noi" instead of "ph-h-ni".
export function sanitizeFilenamePart(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function buildFilename(businessName: string, market: string): string {
  const date = new Date().toISOString().slice(0, 10);
  const parts = [
    "benchmark-scout",
    sanitizeFilenamePart(businessName),
    sanitizeFilenamePart(market),
    date,
  ].filter(Boolean);
  const filename = `${parts.join("-")}.pdf`;
  return filename.length > 100 ? filename.slice(0, 96) + ".pdf" : filename;
}

type PdfContext = {
  doc: jsPDF;
  family: PdfFontFamily;
  text: PdfTextSanitizer;
};

function lastTableY(doc: jsPDF): number {
  return (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable
    .finalY;
}

function addFooter(ctx: PdfContext, showOsm: boolean) {
  const { doc, family, text } = ctx;
  // Checked after all content is drawn, so the count is final.
  const showUnrenderable = text.replacedCount() > 0;
  const pageCount = doc.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFont(family, "normal");
    doc.setFontSize(7);
    doc.setTextColor(90, 90, 90);
    if (showUnrenderable) {
      doc.text(PDF_UNRENDERABLE_NOTICE, MARGIN, 281, {
        maxWidth: CONTENT_WIDTH,
      });
    }
    doc.setFontSize(8);
    doc.text(PDF_DISCLAIMER, MARGIN, 286);
    doc.text(`Page ${i} of ${pageCount}`, PAGE_WIDTH - MARGIN - 20, 286);
    if (showOsm) {
      doc.setFontSize(7);
      doc.text(PDF_OSM_NOTICE, MARGIN, 290);
    }
  }
}

function addSectionTitle(ctx: PdfContext, title: string, y: number): number {
  const { doc, family } = ctx;
  doc.setFontSize(13);
  doc.setTextColor(20, 20, 20);
  doc.setFont(family, "bold");
  doc.text(ctx.text.clean(title), MARGIN, y);
  doc.setFont(family, "normal");
  return y + 7;
}

function addWrappedText(
  ctx: PdfContext,
  text: string,
  y: number,
  options?: {
    fontSize?: number;
    color?: [number, number, number];
    lineHeight?: number;
  }
): number {
  const { doc } = ctx;
  const fontSize = options?.fontSize ?? 10;
  doc.setFontSize(fontSize);
  const color = options?.color ?? [40, 40, 40];
  doc.setTextColor(color[0], color[1], color[2]);
  const lines: string[] = doc.splitTextToSize(ctx.text.clean(text), CONTENT_WIDTH);
  doc.text(lines, MARGIN, y);
  const lineHeight = options?.lineHeight ?? 5;
  return y + lines.length * lineHeight + 3;
}

function ensureSpace(doc: jsPDF, y: number, needed = 20): number {
  if (y + needed > 275) {
    doc.addPage();
    return 20;
  }
  return y;
}

function cleanRows(ctx: PdfContext, rows: string[][]): string[][] {
  return rows.map((row) => row.map((cell) => ctx.text.clean(cell)));
}

function dataModeLabel(reportData: AnalyzeMarketResponse): string {
  const { coverageStatus } = reportData.dataQuality;
  return coverageStatus === "complete"
    ? "Real public data"
    : `Real public data (${coverageStatus})`;
}

function buildLocalPositionRows(reportData: AnalyzeMarketResponse): string[][] {
  const { user, summary } = reportData;
  return [
    ["Your score", formatPdfMetric(user.finalScore, { suffix: "/100" })],
    [
      "Competitor average",
      formatPdfMetric(summary.competitorAverageFinalScore, { suffix: "/100" }),
    ],
    [
      "Competitor website average",
      formatPdfMetric(summary.competitorAverageWebsiteScore, { suffix: "/100" }),
    ],
    ["Market gap", formatPdfMetric(summary.marketGap, { signed: true })],
    [
      "Your rank",
      // Same wording as the screen: ties are shared ranks ("tied for #2").
      summary.yourRank === null
        ? "N/A"
        : `${formatRank(summary.yourRank, user.rankTied ?? summary.yourRankTied)} of ${summary.auditedCompetitorCount + 1}`,
    ],
    // Recomputed from rank and gap for stored v1 reports, as on screen.
    ["Status", displayStatusForSummary(summary) ?? "N/A"],
  ];
}

function buildActionRows(reportData: AnalyzeMarketResponse): string[][] {
  return reportData.report.actionPlan
    .slice(0, 5)
    .map((r) => [
      r.priority,
      `${r.title} ${formatPdfSourceMarkers(r.sourceIds)}`.trim(),
      r.action,
    ]);
}

function buildSnapshotRows(reportData: AnalyzeMarketResponse): string[][] {
  const { user, competitors } = reportData;
  return [user, ...competitors]
    .sort((a, b) => {
      if (a.rank === null && b.rank === null) return 0;
      if (a.rank === null) return 1;
      if (b.rank === null) return -1;
      return a.rank - b.rank;
    })
    .slice(0, 10)
    .map((c) => {
      const keySignal =
        c.signals.momentumSignals[0] ??
        c.signals.offerSignals[0] ??
        c.signals.riskSignals[0] ??
        c.signals.hiringSignals[0] ??
        c.signals.newsSignals[0] ??
        c.signals.changeSignals[0];
      return [
        formatRank(c.rank, c.rankTied),
        c.source === "user" ? `${c.name} (you)` : c.name,
        c.source === "user" ? "Your site" : "Public/OSM",
        formatPdfMetric(c.websiteAudit.websiteScore),
        formatPdfMetric(c.signals.momentumScore),
        formatPdfMetric(c.signals.riskScore),
        formatPdfMetric(c.finalScore),
        keySignal
          ? `${keySignal.label} ${formatPdfSourceMarkers(keySignal.sourceIds)}`.trim()
          : "N/A",
      ];
    });
}

function findingLines(
  items: readonly {
    title: string;
    confidence: string;
    finding: string;
    sourceIds: readonly SourceId[];
  }[]
): { heading: string; body: string }[] {
  return items.slice(0, 5).map((item) => ({
    heading:
      `• ${item.title} [${item.confidence} confidence] ${formatPdfSourceMarkers(item.sourceIds)}`.trim(),
    body: item.finding,
  }));
}

// Every string the document prints, used to decide up front whether the
// Unicode font is needed. Keep in sync with buildBenchmarkPdf.
export function collectPdfText(reportData: AnalyzeMarketResponse): string[] {
  const { input, report, provenance } = reportData;
  return [
    input.businessName,
    input.businessType,
    input.market,
    report.executiveSummary,
    report.methodologyNote,
    report.dataQualityNote,
    ...(reportData.dataQuality.notes ?? []),
    ...(report.actionPlanNote ? [report.actionPlanNote] : []),
    ...findingLines(report.topFindings).flatMap((f) => [f.heading, f.body]),
    ...findingLines(report.topRisks).flatMap((f) => [f.heading, f.body]),
    ...buildLocalPositionRows(reportData).flat(),
    ...buildActionRows(reportData).flat(),
    ...buildSnapshotRows(reportData).flat(),
    ...buildAttributionLines(provenance.sources),
    ...buildSourcesAppendixRows(provenance.sources).flat(),
  ];
}

export type BuildPdfOptions = {
  // Injected by tests; the browser default fetches /fonts/*.ttf.
  loadFont?: () => Promise<UnicodeFontData | null>;
};

export type BuiltPdf = {
  doc: jsPDF;
  fontFamily: PdfFontFamily;
  // Characters replaced with "?" because the active font cannot draw them.
  replacedCharacters: number;
};

export async function buildBenchmarkPdf(
  reportData: AnalyzeMarketResponse,
  options: BuildPdfOptions = {}
): Promise<BuiltPdf> {
  const [{ jsPDF: JsPDF }, { autoTable }] = await Promise.all([
    import("jspdf"),
    import("jspdf-autotable"),
  ]);
  const doc = new JsPDF({ unit: "mm", format: "a4" });

  let family: PdfFontFamily = "helvetica";
  if (needsUnicodeFont(collectPdfText(reportData))) {
    const font = await (options.loadFont ?? loadUnicodeFont)();
    if (font) {
      doc.addFileToVFS("NotoSans-Regular.ttf", font.normal);
      doc.addFont("NotoSans-Regular.ttf", UNICODE_FONT_FAMILY, "normal");
      doc.addFileToVFS("NotoSans-Bold.ttf", font.bold);
      doc.addFont("NotoSans-Bold.ttf", UNICODE_FONT_FAMILY, "bold");
      family = UNICODE_FONT_FAMILY;
    }
  }

  const ctx: PdfContext = {
    doc,
    family,
    text: createPdfTextSanitizer(family),
  };
  const { input, report, provenance } = reportData;
  const showOsm = usesOpenStreetMapData(provenance.sources);
  const tableBase = {
    ...PDF_TABLE_PAGINATION,
    margin: { left: MARGIN, right: MARGIN, top: 20, bottom: 20 },
    theme: "grid" as const,
    headStyles: { fillColor: [30, 41, 59] as [number, number, number] },
  };

  let y = 20;

  doc.setFontSize(20);
  doc.setFont(family, "bold");
  doc.setTextColor(15, 15, 15);
  doc.text("Benchmark Scout", MARGIN, y);
  y += 9;

  doc.setFont(family, "normal");
  // Long names and markets wrap instead of running off the page.
  y = addWrappedText(ctx, input.businessName, y, {
    fontSize: 11,
    color: [60, 60, 60],
    lineHeight: 5,
  }) - 2;
  y = addWrappedText(ctx, `${input.businessType} — ${input.market}`, y, {
    fontSize: 11,
    color: [60, 60, 60],
    lineHeight: 5,
  }) - 2;
  y = addWrappedText(
    ctx,
    `Generated: ${new Date(reportData.generatedAt).toLocaleString()}`,
    y,
    { fontSize: 11, color: [60, 60, 60], lineHeight: 5 }
  ) - 2;
  y = addWrappedText(ctx, `Data mode: ${dataModeLabel(reportData)}`, y, {
    fontSize: 11,
    color: [60, 60, 60],
    lineHeight: 5,
  });
  y += 3;

  doc.setDrawColor(200, 200, 200);
  doc.line(MARGIN, y, PAGE_WIDTH - MARGIN, y);
  y += 8;

  y = addSectionTitle(ctx, "Executive Summary", y);
  y = addWrappedText(ctx, report.executiveSummary, y);
  y += 3;

  y = ensureSpace(doc, y);
  y = addSectionTitle(ctx, "Local Position", y);

  autoTable(doc, {
    ...tableBase,
    startY: y,
    head: [["Metric", "Value"]],
    body: cleanRows(ctx, buildLocalPositionRows(reportData)),
    styles: { font: family, fontSize: 9 },
  });

  y = lastTableY(doc) + 10;

  y = ensureSpace(doc, y, 40);
  y = addSectionTitle(ctx, "Top Findings", y);
  for (const finding of findingLines(report.topFindings)) {
    y = ensureSpace(doc, y, 20);
    y = addWrappedText(ctx, finding.heading, y, {
      fontSize: 10,
      color: [20, 20, 20],
    });
    y = addWrappedText(ctx, finding.body, y, { fontSize: 9, color: [70, 70, 70] });
  }
  y += 2;

  y = ensureSpace(doc, y, 50);
  y = addSectionTitle(ctx, "Recommended Next Actions", y);

  if (report.actionPlan.length === 0) {
    // Same statement as the screen: an empty plan always says why.
    y = addWrappedText(
      ctx,
      report.actionPlanNote ?? "No action plan was produced for this report.",
      y,
      { fontSize: 9, color: [70, 70, 70] }
    );
    y += 8;
  } else {
    autoTable(doc, {
      ...tableBase,
      startY: y,
      head: [["Priority", "Recommendation", "Action"]],
      body: cleanRows(ctx, buildActionRows(reportData)),
      styles: { font: family, fontSize: 8, cellWidth: "wrap" },
      columnStyles: { 0: { cellWidth: 18 }, 1: { cellWidth: 45 }, 2: { cellWidth: "auto" } },
    });

    y = lastTableY(doc) + 10;
  }

  y = ensureSpace(doc, y, 40);
  y = addSectionTitle(ctx, "Top Competitor Snapshot", y);

  autoTable(doc, {
    ...tableBase,
    startY: y,
    head: [
      ["Rank", "Business", "Source", "Website", "Momentum", "Risk", "Final", "Key Signal"],
    ],
    body: cleanRows(ctx, buildSnapshotRows(reportData)),
    styles: { font: family, fontSize: 7 },
  });

  y = lastTableY(doc) + 10;

  if (report.topRisks.length > 0) {
    y = ensureSpace(doc, y, 30);
    y = addSectionTitle(ctx, "Possible Risks / Changes", y);
    for (const risk of findingLines(report.topRisks)) {
      y = ensureSpace(doc, y, 18);
      y = addWrappedText(ctx, risk.heading, y, {
        fontSize: 9,
        color: [20, 20, 20],
      });
      y = addWrappedText(ctx, risk.body, y, { fontSize: 8, color: [90, 90, 90] });
    }
    y += 2;
  }

  y = ensureSpace(doc, y, 30);
  y = addSectionTitle(ctx, "Methodology", y);
  y = addWrappedText(ctx, report.methodologyNote, y, { fontSize: 8 });
  y += 2;

  y = ensureSpace(doc, y, 30);
  y = addSectionTitle(ctx, "Data Quality", y);
  y = addWrappedText(ctx, report.dataQualityNote, y, { fontSize: 8 });
  for (const note of reportData.dataQuality.notes ?? []) {
    y = ensureSpace(doc, y, 12);
    y = addWrappedText(ctx, `- ${note}`, y, { fontSize: 8, lineHeight: 4 });
  }

  y = ensureSpace(doc, y + 4, 30);
  y = addSectionTitle(ctx, "Data Sources and Attribution", y);
  for (const line of buildAttributionLines(provenance.sources)) {
    y = ensureSpace(doc, y, 12);
    y = addWrappedText(ctx, line, y, { fontSize: 8, lineHeight: 4 });
  }

  y = ensureSpace(doc, y + 4, 50);
  y = addSectionTitle(ctx, "Sources Appendix", y);
  autoTable(doc, {
    ...tableBase,
    startY: y,
    head: [["ID", "Provider", "Entity", "URL", "Access time", "Status"]],
    body: cleanRows(ctx, buildSourcesAppendixRows(provenance.sources)),
    styles: { font: family, fontSize: 6, cellWidth: "wrap", overflow: "linebreak" },
    // The URL cell shows readable text; the full URL is attached as a link.
    didDrawCell: (data) => {
      if (data.section !== "body" || data.column.index !== 3) return;
      const url = linkableSourceUrl(provenance.sources[data.row.index]?.url);
      if (!url) return;
      doc.link(data.cell.x, data.cell.y, data.cell.width, data.cell.height, { url });
    },
    columnStyles: {
      0: { cellWidth: 12 },
      1: { cellWidth: 22 },
      2: { cellWidth: 36 },
      3: { cellWidth: 55 },
      4: { cellWidth: 39 },
      5: { cellWidth: 18 },
    },
  });

  addFooter(ctx, showOsm);
  return { doc, fontFamily: family, replacedCharacters: ctx.text.replacedCount() };
}

export async function downloadBenchmarkPdf(
  reportData: AnalyzeMarketResponse
): Promise<void> {
  const { doc } = await buildBenchmarkPdf(reportData);
  doc.save(buildFilename(reportData.input.businessName, reportData.input.market));
}
