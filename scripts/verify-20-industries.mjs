/**
 * Clears the analysis report cache for each catalog entry, runs a live
 * analyze-market pass, and checks that the report is full / in-depth.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { validateRealReport } from "./validate-real-report.mjs";

const baseUrl = (process.env.BENCHMARK_SCOUT_BASE_URL ?? "http://127.0.0.1:3000").replace(
  /\/$/,
  ""
);
const MIN_INTERVAL_MS = Number(process.env.VERIFY_MIN_INTERVAL_MS ?? 65_000);
const catalog = JSON.parse(
  await readFile(new URL("../data/real-samples/catalog.json", import.meta.url), "utf8")
);
const ids = (process.env.GATE_CATALOG_IDS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const selected = ids.length
  ? catalog.filter((entry) => ids.includes(entry.id))
  : catalog.slice(0, 20);

const cacheRoot = path.resolve(process.cwd(), process.env.CACHE_DIR ?? ".cache", "reports");
const outputDirectory = path.join(process.cwd(), "artifacts", "industry-verify");
await mkdir(outputDirectory, { recursive: true });
const startedAt = new Date().toISOString();
const outputPath = path.join(
  outputDirectory,
  `${startedAt.replaceAll(":", "-")}.json`
);

function analysisCacheKey(entry) {
  return JSON.stringify({
    businessName: entry.businessName,
    businessUrl: entry.businessUrl,
    businessType: entry.businessType,
    market: entry.market,
  });
}

function reportCacheFile(entry) {
  const versioned = `report:v2:${analysisCacheKey(entry)}`;
  const hash = createHash("sha256").update(versioned).digest("hex");
  return path.join(cacheRoot, `${hash}.json`);
}

async function deleteReportCache(entry) {
  try {
    await unlink(reportCacheFile(entry));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function depthAssessment(report, stats) {
  const competitors = Array.isArray(report.competitors) ? report.competitors.length : 0;
  const recommendations = Array.isArray(report.recommendations)
    ? report.recommendations.length
    : 0;
  const findings = Array.isArray(report.findings) ? report.findings.length : 0;
  const hasSummary = report.summary && typeof report.summary === "object";
  const hasProvenance =
    report.provenance?.policy === "real-only" &&
    report.provenance?.containsSyntheticData === false &&
    Array.isArray(report.provenance?.sources) &&
    report.provenance.sources.length > 0;
  const full =
    Boolean(report.reportId || stats.reportId) &&
    stats.sourceCount >= 10 &&
    stats.scoredEntityCount >= 2 &&
    competitors >= 3 &&
    recommendations >= 1 &&
    hasSummary &&
    hasProvenance;
  return {
    full,
    competitors,
    recommendations,
    findings,
    hasSummary,
    hasProvenance,
    sourceCount: stats.sourceCount,
    scoredEntityCount: stats.scoredEntityCount,
  };
}

const results = [];
let lastAnalyzeAt = 0;

async function save() {
  await writeFile(
    outputPath,
    `${JSON.stringify({ baseUrl, startedAt, selectedCatalogIds: selected.map((e) => e.id), results }, null, 2)}\n`
  );
}

for (const entry of selected) {
  const row = {
    catalogId: entry.id,
    industry: entry.industry,
    businessName: entry.businessName,
    startedAt: new Date().toISOString(),
    status: "running",
  };
  results.push(row);
  await save();

  try {
    await deleteReportCache(entry);
    const wait = lastAnalyzeAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastAnalyzeAt = Date.now();

    const response = await fetch(`${baseUrl}/api/analyze-market`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        businessName: entry.businessName,
        businessUrl: entry.businessUrl,
        businessType: entry.businessType,
        market: entry.market,
      }),
      signal: AbortSignal.timeout(75_000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(
        `${response.status} ${body?.code ?? "UNKNOWN"}: ${body?.error?.message ?? body?.error ?? "analysis failed"}`
      );
    }
    if (body?.dataQuality?.cacheHit === true) {
      throw new Error("cache still hit after delete — unexpected");
    }

    const stats = validateRealReport(body);
    if (typeof body.reportId !== "string" || !body.reportId) {
      throw new Error("analysis did not persist a reportId");
    }
    const depth = depthAssessment(body, { ...stats, reportId: body.reportId });

    Object.assign(row, {
      status: depth.full ? "passed" : "thin",
      reportId: body.reportId,
      cacheHit: body.dataQuality?.cacheHit === true,
      coverageStatus: body.dataQuality?.coverageStatus ?? null,
      realCompetitorsFound: body.dataQuality?.realCompetitorsFound ?? null,
      scoredCompetitors: body.dataQuality?.scoredCompetitors ?? null,
      ...depth,
      completedAt: new Date().toISOString(),
    });
  } catch (error) {
    Object.assign(row, {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      completedAt: new Date().toISOString(),
    });
  }
  await save();
  console.log(
    `${row.status.toUpperCase()} ${row.industry} (${row.catalogId})` +
      (row.reportId ? ` report=${row.reportId} sources=${row.sourceCount}` : "") +
      (row.error ? ` :: ${row.error}` : "")
  );
}

const passed = results.filter((row) => row.status === "passed").length;
const thin = results.filter((row) => row.status === "thin").length;
const failed = results.filter((row) => row.status === "failed").length;
console.log(
  `Industry verify: ${passed} full, ${thin} thin, ${failed} failed / ${results.length}. Evidence: ${outputPath}`
);
if (failed > 0 || thin > 0) process.exitCode = 1;
