import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
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

export function buildSourcesAppendixRows(
  sources: readonly SourceReference[]
): string[][] {
  return sources.map((source) => [
    `[${source.id}]`,
    source.provider,
    source.businessName
      ? `${source.businessName}${source.title !== source.businessName ? ` — ${source.title}` : ""}`
      : source.title,
    source.url ?? "N/A",
    source.accessedAt,
    source.status,
  ]);
}

export function sanitizeFilenamePart(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-");
}

export function buildFilename(businessName: string, market: string): string {
  const date = new Date().toISOString().slice(0, 10);
  const name = sanitizeFilenamePart(businessName);
  const mkt = sanitizeFilenamePart(market);
  const filename = `benchmark-scout-${name}-${mkt}-${date}.pdf`;
  return filename.length > 100 ? filename.slice(0, 96) + ".pdf" : filename;
}

function addFooter(doc: jsPDF) {
  const pageCount = doc.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFontSize(8);
    doc.setTextColor(120, 120, 120);
    doc.text(
      "Real public-source benchmark. Not verified internal company data.",
      MARGIN,
      290
    );
    doc.text(`Page ${i} of ${pageCount}`, PAGE_WIDTH - MARGIN - 20, 290);
  }
}

function addSectionTitle(doc: jsPDF, title: string, y: number): number {
  doc.setFontSize(13);
  doc.setTextColor(20, 20, 20);
  doc.setFont("helvetica", "bold");
  doc.text(title, MARGIN, y);
  doc.setFont("helvetica", "normal");
  return y + 7;
}

function addWrappedText(
  doc: jsPDF,
  text: string,
  y: number,
  options?: { fontSize?: number; color?: [number, number, number] }
): number {
  doc.setFontSize(options?.fontSize ?? 10);
  const color = options?.color ?? [40, 40, 40];
  doc.setTextColor(color[0], color[1], color[2]);
  const lines = doc.splitTextToSize(text, CONTENT_WIDTH);
  doc.text(lines, MARGIN, y);
  return y + lines.length * 5 + 3;
}

function ensureSpace(doc: jsPDF, y: number, needed = 20): number {
  if (y + needed > 275) {
    doc.addPage();
    return 20;
  }
  return y;
}

export function downloadBenchmarkPdf(reportData: AnalyzeMarketResponse): void {
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const { input, user, competitors, summary, report, dataQuality } = reportData;

  let y = 20;

  doc.setFontSize(20);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(15, 15, 15);
  doc.text("Benchmark Scout", MARGIN, y);
  y += 9;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(11);
  doc.setTextColor(60, 60, 60);
  doc.text(`${input.businessName}`, MARGIN, y);
  y += 6;
  doc.text(`${input.businessType} — ${input.market}`, MARGIN, y);
  y += 6;

  const dataMode =
    dataQuality.coverageStatus === "complete"
      ? "Real public data"
      : `Real public data (${dataQuality.coverageStatus})`;

  doc.text(
    `Generated: ${new Date(reportData.generatedAt).toLocaleString()}`,
    MARGIN,
    y
  );
  y += 6;
  doc.text(`Data mode: ${dataMode}`, MARGIN, y);
  y += 10;

  doc.setDrawColor(200, 200, 200);
  doc.line(MARGIN, y, PAGE_WIDTH - MARGIN, y);
  y += 8;

  y = addSectionTitle(doc, "Executive Summary", y);
  y = addWrappedText(doc, report.executiveSummary, y);
  y += 3;

  y = ensureSpace(doc, y);
  y = addSectionTitle(doc, "Local Position", y);

  autoTable(doc, {
    ...PDF_TABLE_PAGINATION,
    startY: y,
    margin: { left: MARGIN, right: MARGIN, top: 20, bottom: 20 },
    head: [["Metric", "Value"]],
    body: [
      ["Your score", formatPdfMetric(user.finalScore, { suffix: "/100" })],
      [
        "Competitor average",
        formatPdfMetric(summary.competitorAverageFinalScore, {
          suffix: "/100",
        }),
      ],
      [
        "Competitor website average",
        formatPdfMetric(summary.competitorAverageWebsiteScore, {
          suffix: "/100",
        }),
      ],
      ["Market gap", formatPdfMetric(summary.marketGap, { signed: true })],
      [
        "Your rank",
        summary.yourRank === null
          ? "N/A"
          : `#${summary.yourRank} of ${summary.auditedCompetitorCount + 1}`,
      ],
      ["Status", summary.status ?? "N/A"],
    ],
    theme: "grid",
    styles: { fontSize: 9 },
    headStyles: { fillColor: [30, 41, 59] },
  });

  y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable
    .finalY + 10;

  y = ensureSpace(doc, y, 40);
  y = addSectionTitle(doc, "Top Findings", y);
  for (const finding of report.topFindings.slice(0, 5)) {
    y = ensureSpace(doc, y, 20);
    y = addWrappedText(
      doc,
      `• ${finding.title} [${finding.confidence} confidence] ${formatPdfSourceMarkers(finding.sourceIds)}`.trim(),
      y,
      { fontSize: 10, color: [20, 20, 20] }
    );
    y = addWrappedText(doc, finding.finding, y, { fontSize: 9, color: [70, 70, 70] });
  }
  y += 2;

  y = ensureSpace(doc, y, 50);
  y = addSectionTitle(doc, "Recommended Next Actions", y);

  autoTable(doc, {
    ...PDF_TABLE_PAGINATION,
    startY: y,
    margin: { left: MARGIN, right: MARGIN, top: 20, bottom: 20 },
    head: [["Priority", "Recommendation", "Action"]],
    body: report.actionPlan
      .slice(0, 5)
      .map((r) => [
        r.priority,
        `${r.title} ${formatPdfSourceMarkers(r.sourceIds)}`.trim(),
        r.action,
      ]),
    theme: "grid",
    styles: { fontSize: 8, cellWidth: "wrap" },
    columnStyles: { 0: { cellWidth: 18 }, 1: { cellWidth: 45 }, 2: { cellWidth: "auto" } },
    headStyles: { fillColor: [30, 41, 59] },
  });

  y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable
    .finalY + 10;

  y = ensureSpace(doc, y, 40);
  y = addSectionTitle(doc, "Top Competitor Snapshot", y);

  const snapshotRows = [user, ...competitors]
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
        c.rank === null ? "N/A" : String(c.rank),
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

  autoTable(doc, {
    ...PDF_TABLE_PAGINATION,
    startY: y,
    margin: { left: MARGIN, right: MARGIN, top: 20, bottom: 20 },
    head: [
      ["Rank", "Business", "Source", "Website", "Momentum", "Risk", "Final", "Key Signal"],
    ],
    body: snapshotRows,
    theme: "grid",
    styles: { fontSize: 7 },
    headStyles: { fillColor: [30, 41, 59] },
  });

  y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable
    .finalY + 10;

  if (report.topRisks.length > 0) {
    y = ensureSpace(doc, y, 30);
    y = addSectionTitle(doc, "Possible Risks / Changes", y);
    for (const risk of report.topRisks.slice(0, 5)) {
      y = ensureSpace(doc, y, 18);
      y = addWrappedText(
        doc,
        `• ${risk.title} [${risk.confidence} confidence] ${formatPdfSourceMarkers(risk.sourceIds)}`.trim(),
        y,
        {
          fontSize: 9,
          color: [20, 20, 20],
        }
      );
      y = addWrappedText(doc, risk.finding, y, { fontSize: 8, color: [90, 90, 90] });
    }
    y += 2;
  }

  y = ensureSpace(doc, y, 30);
  y = addSectionTitle(doc, "Methodology", y);
  y = addWrappedText(doc, report.methodologyNote, y, { fontSize: 8 });
  y += 2;

  y = ensureSpace(doc, y, 30);
  y = addSectionTitle(doc, "Data Quality", y);
  y = addWrappedText(doc, report.dataQualityNote, y, { fontSize: 8 });

  y = ensureSpace(doc, y + 4, 50);
  y = addSectionTitle(doc, "Sources Appendix", y);
  autoTable(doc, {
    ...PDF_TABLE_PAGINATION,
    startY: y,
    margin: { left: MARGIN, right: MARGIN, top: 20, bottom: 20 },
    head: [["ID", "Provider", "Entity", "URL", "Access time", "Status"]],
    body: buildSourcesAppendixRows(reportData.provenance.sources),
    theme: "grid",
    styles: { fontSize: 6, cellWidth: "wrap", overflow: "linebreak" },
    columnStyles: {
      0: { cellWidth: 12 },
      1: { cellWidth: 22 },
      2: { cellWidth: 36 },
      3: { cellWidth: 55 },
      4: { cellWidth: 39 },
      5: { cellWidth: 18 },
    },
    headStyles: { fillColor: [30, 41, 59] },
  });

  addFooter(doc);

  doc.save(buildFilename(input.businessName, input.market));
}
