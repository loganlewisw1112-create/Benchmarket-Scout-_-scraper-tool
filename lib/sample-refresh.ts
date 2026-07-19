import crypto from "node:crypto";
import { analyzeMarket } from "./analyze-market";
import { deleteCache } from "./cache";
import { assertRealDataResponse } from "./invariants";
import { getSampleCatalogEntry, type SampleCatalogEntry } from "./sample-catalog";
import {
  newReportId,
  replaceSampleSnapshot,
  saveReport,
  type SampleSnapshotV2,
} from "./store";
import type { AnalyzeMarketResponse } from "./types";

export const SAMPLE_REFRESH_HEADER = "x-sample-refresh-secret";

export class SampleRefreshQualityError extends Error {
  readonly violations: string[];

  constructor(violations: string[]) {
    super(`Real sample quality gate failed: ${violations.join(" ")}`);
    this.name = "SampleRefreshQualityError";
    this.violations = violations;
  }
}

function sha256(value: string): Buffer {
  return crypto.createHash("sha256").update(value).digest();
}

export function isSampleRefreshConfigured(): boolean {
  return Boolean(process.env.SAMPLE_REFRESH_SECRET?.trim());
}

export function sampleRefreshSecretMatches(provided: string): boolean {
  const expected = process.env.SAMPLE_REFRESH_SECRET?.trim();
  if (!expected) return false;
  return crypto.timingSafeEqual(sha256(provided), sha256(expected));
}

export function sampleRefreshViolations(report: AnalyzeMarketResponse): string[] {
  const violations: string[] = [];
  try {
    assertRealDataResponse(report);
  } catch (error) {
    violations.push(
      error instanceof Error ? error.message : "Real-data invariant failed."
    );
  }

  if (
    report.user.websiteAudit.skipped ||
    report.user.auditStatus !== "complete" ||
    report.user.websiteAudit.auditStatus !== "complete"
  ) {
    violations.push("The submitted business website audit did not succeed.");
  }
  const realCompetitors = report.competitors.filter(
    (competitor) => competitor.source === "overpass"
  );
  if (realCompetitors.length < 6) {
    violations.push(`Only ${realCompetitors.length} real competitors were found; 6 are required.`);
  }
  const successfulCompetitorAudits = realCompetitors.filter(
    (competitor) =>
      !competitor.websiteAudit.skipped &&
      competitor.auditStatus === "complete" &&
      competitor.websiteAudit.auditStatus === "complete"
  ).length;
  if (successfulCompetitorAudits < 3) {
    violations.push(
      `Only ${successfulCompetitorAudits} competitor website audits succeeded; 3 are required.`
    );
  }
  return violations;
}

function analysisCacheKeys(entry: SampleCatalogEntry): string[] {
  const input = {
    businessName: entry.businessName,
    businessUrl: entry.businessUrl,
    businessType: entry.businessType,
    market: entry.market,
  };
  return [JSON.stringify(input)];
}

export type SampleRefreshDependencies = {
  analyze: (input: SampleCatalogEntry) => Promise<AnalyzeMarketResponse>;
  clearCache: (entry: SampleCatalogEntry) => Promise<void>;
  persistReport: (report: AnalyzeMarketResponse) => Promise<string>;
  replaceSnapshot: (snapshot: SampleSnapshotV2) => Promise<void>;
  now: () => Date;
  sampleId: () => string;
};

const defaultDependencies: SampleRefreshDependencies = {
  analyze: analyzeMarket,
  clearCache: async (entry) => {
    await Promise.all(
      [...new Set(analysisCacheKeys(entry))].map((key) => deleteCache("reports", key))
    );
  },
  persistReport: saveReport,
  replaceSnapshot: replaceSampleSnapshot,
  now: () => new Date(),
  sampleId: newReportId,
};

export async function refreshRealSample(
  catalogId: string,
  dependencies: SampleRefreshDependencies = defaultDependencies
): Promise<SampleSnapshotV2> {
  const entry = getSampleCatalogEntry(catalogId);
  if (!entry) throw new Error(`Unknown real sample catalog id ${catalogId}.`);

  await dependencies.clearCache(entry);
  const report = await dependencies.analyze(entry);
  const violations = sampleRefreshViolations(report);
  if (violations.length > 0) throw new SampleRefreshQualityError(violations);

  // Every gate is evaluated before either durable write. Snapshot replacement
  // is a single SET/rename, so a failed run leaves the last good sample intact.
  const reportId = await dependencies.persistReport(report);
  const snapshot: SampleSnapshotV2 = {
    schemaVersion: 2,
    sampleId: dependencies.sampleId(),
    catalogId: entry.id,
    reportId,
    generatedAt: dependencies.now().toISOString(),
    report,
  };
  await dependencies.replaceSnapshot(snapshot);
  return snapshot;
}
