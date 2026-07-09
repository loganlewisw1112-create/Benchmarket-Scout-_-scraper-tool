import { describe, expect, it } from "vitest";
import { generateBenchmarkReport } from "./report";
import { makeReport, makeSignalList, makeSummary } from "./test-fixtures";
import type { AnalyzeMarketRequest, DataQuality, Recommendation } from "./types";

const input: AnalyzeMarketRequest = {
  businessName: "Acme Plumbing",
  businessUrl: "https://acme.example.org",
  businessType: "plumbing",
  market: "Austin, TX",
};

const noNotesDataQuality: DataQuality = {
  discoverySource: "overpass",
  usedMockData: false,
  liveCompetitorsFound: 3,
  failedHomepageFetches: 0,
  limitedAudits: 0,
  cacheHit: false,
  notes: [],
};

const recommendations: Recommendation[] = [
  { title: "Close the SEO gap", why: "because", action: "do it", priority: "high" },
];

function userWithScores(scoreBreakdown: {
  seo: number;
  conversion: number;
  trust: number;
  content: number;
  technical: number;
}) {
  return makeReport({
    name: "Acme Plumbing",
    source: "user",
    finalScore: 40,
    website: "https://acme.example.org",
    websiteAudit: { skipped: false, websiteScore: 30, scoreBreakdown },
  });
}

describe("generateBenchmarkReport", () => {
  it("includes the business name and market in the title", () => {
    const user = userWithScores({ seo: 10, conversion: 10, trust: 10, content: 10, technical: 5 });
    const competitor = makeReport({
      name: "Rival Plumbing",
      source: "overpass",
      finalScore: 70,
      websiteAudit: { skipped: false, websiteScore: 80, scoreBreakdown: { seo: 20, conversion: 20, trust: 15, content: 15, technical: 8 } },
    });

    const report = generateBenchmarkReport({
      input,
      user,
      competitors: [competitor],
      summary: makeSummary({ competitorCount: 1, yourRank: 2, competitorAverageFinalScore: 70, strongestCompetitor: "Rival Plumbing" }),
      recommendations,
      dataQuality: noNotesDataQuality,
    });

    expect(report.title).toBe("Benchmark Scout Report — Acme Plumbing (Austin, TX)");
    expect(report.executiveSummary.length).toBeGreaterThan(0);
    expect(report.positionStatement).toContain("Acme Plumbing");
    expect(report.actionPlan).toBe(recommendations);
  });

  it("caps topFindings at 5 even with multiple category gaps and a strongest competitor", () => {
    const user = userWithScores({ seo: 5, conversion: 5, trust: 5, content: 5, technical: 2 });
    const competitor = makeReport({
      name: "Rival Plumbing",
      source: "overpass",
      finalScore: 90,
      websiteAudit: { skipped: false, websiteScore: 95, scoreBreakdown: { seo: 25, conversion: 25, trust: 20, content: 20, technical: 10 } },
    });

    const report = generateBenchmarkReport({
      input,
      user,
      competitors: [competitor],
      summary: makeSummary({ competitorCount: 1, yourRank: 2, competitorAverageFinalScore: 90, strongestCompetitor: "Rival Plumbing" }),
      recommendations,
      dataQuality: noNotesDataQuality,
    });

    expect(report.topFindings.length).toBeLessThanOrEqual(5);
    expect(report.topFindings.length).toBe(5);
    expect(report.topFindings.some((f) => f.title === "Strongest tracked competitor")).toBe(true);
    expect(report.topFindings.some((f) => f.title === "Local market position")).toBe(true);
    expect(report.topFindings.some((f) => f.title === "Market-wide momentum signal adoption")).toBe(true);
  });

  it("returns a single low-confidence finding when there are no competitors", () => {
    const user = userWithScores({ seo: 10, conversion: 10, trust: 10, content: 10, technical: 5 });

    const report = generateBenchmarkReport({
      input,
      user,
      competitors: [],
      summary: makeSummary({ competitorCount: 0, yourRank: 1 }),
      recommendations,
      dataQuality: noNotesDataQuality,
    });

    expect(report.topFindings).toHaveLength(1);
    expect(report.topFindings[0].title).toBe("Limited market comparison available");
    expect(report.topFindings[0].confidence).toBe("low");
  });

  it("caps topRisks at 3 across user and competitor risk/change signals", () => {
    const user = userWithScores({ seo: 10, conversion: 10, trust: 10, content: 10, technical: 5 });
    user.signals.riskSignals = makeSignalList(2, "user-risk");

    const competitor = makeReport({
      name: "Rival Plumbing",
      source: "overpass",
      finalScore: 60,
      signals: {
        riskSignals: makeSignalList(1, "rival-risk"),
        changeSignals: makeSignalList(2, "rival-change"),
      },
    });

    const report = generateBenchmarkReport({
      input,
      user,
      competitors: [competitor],
      summary: makeSummary({ competitorCount: 1, yourRank: 1 }),
      recommendations,
      dataQuality: noNotesDataQuality,
    });

    expect(report.topRisks).toHaveLength(3);
  });

  it("sorts competitorHighlights by final score descending and caps at 5", () => {
    const user = userWithScores({ seo: 10, conversion: 10, trust: 10, content: 10, technical: 5 });
    const competitors = [10, 90, 50, 30, 70, 20, 80].map((score, idx) =>
      makeReport({ name: `Rival ${idx}`, source: "overpass", finalScore: score })
    );

    const report = generateBenchmarkReport({
      input,
      user,
      competitors,
      summary: makeSummary({ competitorCount: competitors.length, yourRank: 4 }),
      recommendations,
      dataQuality: noNotesDataQuality,
    });

    expect(report.competitorHighlights).toHaveLength(5);
    const scores = report.competitorHighlights.map((h) =>
      Number(h.conciseSummary.match(/Scores (\d+)/)?.[1])
    );
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(scores[0]).toBe(90);
  });

  it("uses custom data quality notes verbatim when present", () => {
    const user = userWithScores({ seo: 10, conversion: 10, trust: 10, content: 10, technical: 5 });
    const report = generateBenchmarkReport({
      input,
      user,
      competitors: [],
      summary: makeSummary({ competitorCount: 0, yourRank: 1 }),
      recommendations,
      dataQuality: { ...noNotesDataQuality, notes: ["Custom fallback note for this run."] },
    });

    expect(report.dataQualityNote).toContain("Custom fallback note for this run.");
  });

  it("mentions fallback demo data in the executive summary when mock data was used", () => {
    const user = userWithScores({ seo: 10, conversion: 10, trust: 10, content: 10, technical: 5 });
    const report = generateBenchmarkReport({
      input,
      user,
      competitors: [makeReport({ name: "Mock Co", source: "mock", finalScore: 50 })],
      summary: makeSummary({ competitorCount: 1, yourRank: 2 }),
      recommendations,
      dataQuality: { ...noNotesDataQuality, usedMockData: true },
    });

    expect(report.executiveSummary).toContain("labeled fallback demo data");
  });
});
