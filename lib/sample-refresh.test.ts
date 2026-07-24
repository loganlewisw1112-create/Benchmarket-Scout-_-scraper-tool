import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnalyzeMarketResponse, CompetitorReport } from "./types";

vi.mock("./analyze-market", () => ({ analyzeMarket: vi.fn() }));
vi.mock("./invariants", () => ({
  assertRealDataResponse: (report: AnalyzeMarketResponse) => {
    if (report.schemaVersion !== 2) throw new Error("schemaVersion must be 2.");
  },
}));

import {
  isSampleRefreshConfigured,
  refreshRealSample,
  sampleRefreshSecretMatches,
  SampleRefreshQualityError,
  type SampleRefreshDependencies,
} from "./sample-refresh";

function competitor(index: number, successful: boolean): CompetitorReport {
  return {
    source: "overpass",
    auditStatus: successful ? "complete" : "unavailable",
    websiteAudit: {
      skipped: !successful,
      auditStatus: successful ? "complete" : "unavailable",
    },
    id: `competitor-${index}`,
  } as CompetitorReport;
}

function gateReport(realCount = 4, successfulCount = 2): AnalyzeMarketResponse {
  return {
    schemaVersion: 2,
    user: {
      auditStatus: "complete",
      websiteAudit: { skipped: false, auditStatus: "complete" },
    },
    competitors: Array.from({ length: realCount }, (_, index) =>
      competitor(index, index < successfulCount)
    ),
  } as AnalyzeMarketResponse;
}

afterEach(() => {
  delete process.env.SAMPLE_REFRESH_SECRET;
});

describe("sample refresh authorization", () => {
  it("uses the configured secret and rejects missing or different values", () => {
    expect(isSampleRefreshConfigured()).toBe(false);
    process.env.SAMPLE_REFRESH_SECRET = "correct horse battery staple";
    expect(isSampleRefreshConfigured()).toBe(true);
    expect(sampleRefreshSecretMatches("correct horse battery staple")).toBe(true);
    expect(sampleRefreshSecretMatches("wrong")).toBe(false);
  });
});

describe("strict real-sample refresh gate", () => {
  it("persists and atomically replaces only after all gates pass", async () => {
    const report = gateReport();
    const calls: string[] = [];
    const dependencies: SampleRefreshDependencies = {
      analyze: vi.fn(async () => report),
      clearCache: vi.fn(async () => void calls.push("cache")),
      persistReport: vi.fn(async () => {
        calls.push("report");
        return "reportabc123";
      }),
      replaceSnapshot: vi.fn(async () => void calls.push("snapshot")),
      now: () => new Date("2026-07-19T12:00:00.000Z"),
      sampleId: () => "sampleabc123",
    };

    const result = await refreshRealSample("bakery-firebrand-bread", dependencies);
    expect(result).toMatchObject({
      schemaVersion: 2,
      sampleId: "sampleabc123",
      reportId: "reportabc123",
      catalogId: "bakery-firebrand-bread",
    });
    expect(calls).toEqual(["cache", "report", "snapshot"]);
  });

  it("retains the last good snapshot when any quality gate fails", async () => {
    const dependencies: SampleRefreshDependencies = {
      analyze: vi.fn(async () => gateReport(3, 1)),
      clearCache: vi.fn(async () => undefined),
      persistReport: vi.fn(async () => "reportabc123"),
      replaceSnapshot: vi.fn(async () => undefined),
      now: () => new Date(),
      sampleId: () => "sampleabc123",
    };
    await expect(
      refreshRealSample("bakery-firebrand-bread", dependencies)
    ).rejects.toBeInstanceOf(SampleRefreshQualityError);
    expect(dependencies.persistReport).not.toHaveBeenCalled();
    expect(dependencies.replaceSnapshot).not.toHaveBeenCalled();
  });

  it("accepts four real competitors with two successful audits", async () => {
    const report = gateReport(4, 2);
    const dependencies: SampleRefreshDependencies = {
      analyze: vi.fn(async () => report),
      clearCache: vi.fn(async () => undefined),
      persistReport: vi.fn(async () => "reportabc123"),
      replaceSnapshot: vi.fn(async () => undefined),
      now: () => new Date("2026-07-19T12:00:00.000Z"),
      sampleId: () => "sampleabc123",
    };
    await expect(
      refreshRealSample("bakery-firebrand-bread", dependencies)
    ).resolves.toMatchObject({ catalogId: "bakery-firebrand-bread" });
  });
});
