import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import type { AnalyzeMarketResponse } from "./types";

const PAGE_WIDTH = 210;
const MARGIN = 14;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

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
      "Public-signal benchmark. Not verified internal company data.",
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

  const dataMode = dataQuality.usedMockData
    ? dataQuality.liveCompetitorsFound > 0
      ? "Mixed (live + fallback demo data)"
      : "Fallback demo data"
    : "Live public data";

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
    startY: y,
    margin: { left: MARGIN, right: MARGIN },
    head: [["Metric", "Value"]],
    body: [
      ["Your score", `${user.finalScore}/100`],
      [
        "Competitor average",
        `${summary.competitorAverageFinalScore}/100`,
      ],
      ["Market gap", `${summary.marketGap >= 0 ? "+" : ""}${summary.marketGap}`],
      ["Your rank", `#${summary.yourRank} of ${summary.competitorCount + 1}`],
      ["Status", summary.status],
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
      `• ${finding.title} [${finding.confidence} confidence]`,
      y,
      { fontSize: 10, color: [20, 20, 20] }
    );
    y = addWrappedText(doc, finding.finding, y, { fontSize: 9, color: [70, 70, 70] });
  }
  y += 2;

  y = ensureSpace(doc, y, 50);
  y = addSectionTitle(doc, "Recommended Next Actions", y);

  autoTable(doc, {
    startY: y,
    margin: { left: MARGIN, right: MARGIN },
    head: [["Priority", "Recommendation", "Action"]],
    body: report.actionPlan
      .slice(0, 5)
      .map((r) => [r.priority, r.title, r.action]),
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
    .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99))
    .slice(0, 10)
    .map((c) => [
      String(c.rank ?? "-"),
      c.source === "user" ? `${c.name} (you)` : c.name,
      c.source === "mock" ? "Fallback demo" : c.source === "user" ? "Your site" : "Public/OSM",
      `${c.websiteAudit.websiteScore}`,
      `${c.signals.momentumScore}`,
      `${c.signals.riskScore}`,
      `${c.finalScore}`,
      c.signals.momentumSignals[0]?.label ??
        c.signals.offerSignals[0]?.label ??
        "—",
    ]);

  autoTable(doc, {
    startY: y,
    margin: { left: MARGIN, right: MARGIN },
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
      y = addWrappedText(doc, `• ${risk.title} [${risk.confidence} confidence]`, y, {
        fontSize: 9,
        color: [20, 20, 20],
      });
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

  addFooter(doc);

  doc.save(buildFilename(input.businessName, input.market));
}
