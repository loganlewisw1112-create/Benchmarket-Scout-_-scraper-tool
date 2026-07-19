import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { validateRealReport, validateSharedReportHtml } from "./validate-real-report.mjs";

const MIN_INTERVAL_MS = 65_000;
const MAX_ATTEMPTS = 3;
const baseUrl = (process.env.BENCHMARK_SCOUT_BASE_URL ?? "").replace(/\/$/, "");
if (!baseUrl) throw new Error("BENCHMARK_SCOUT_BASE_URL is required.");

const catalog = JSON.parse(await readFile(new URL("../data/real-samples/catalog.json", import.meta.url), "utf8"));
if (!Array.isArray(catalog) || catalog.length !== 25) throw new Error("Expected exactly 25 Alameda catalog entries.");

const outputDirectory = path.join(process.cwd(), "artifacts", "launch-gate");
await mkdir(outputDirectory, { recursive: true });
const startedAt = new Date().toISOString();
const outputPath = path.join(outputDirectory, `${startedAt.replaceAll(":", "-")}.json`);
const results = [];
let lastAnalyzeAt = 0;
let analyzeNotBeforeAt = 0;

function requestSignal(timeoutMs) {
  return AbortSignal.timeout(timeoutMs);
}

function headers() {
  const value = { "content-type": "application/json", accept: "application/json" };
  if (process.env.SCOUT_API_KEY) value["x-scout-key"] = process.env.SCOUT_API_KEY;
  if (process.env.VERCEL_AUTOMATION_BYPASS_SECRET) {
    value["x-vercel-protection-bypass"] = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  }
  return value;
}

async function saveProgress() {
  await writeFile(outputPath, `${JSON.stringify({ baseUrl, startedAt, results }, null, 2)}\n`, "utf8");
}

async function spaceAnalyzeCalls() {
  const nextAllowedAt = Math.max(lastAnalyzeAt + MIN_INTERVAL_MS, analyzeNotBeforeAt);
  const remaining = nextAllowedAt - Date.now();
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
  lastAnalyzeAt = Date.now();
}

function recordRetryAfter(response) {
  const value = response.headers.get("retry-after");
  if (!value) return;
  const seconds = Number(value);
  const retryAt = Number.isFinite(seconds)
    ? Date.now() + Math.max(0, seconds) * 1000
    : Date.parse(value);
  if (Number.isFinite(retryAt)) analyzeNotBeforeAt = Math.max(analyzeNotBeforeAt, retryAt);
}

function errorCode(body) {
  return body?.code ?? body?.error?.code;
}

async function fetchVerification(pathname) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}${pathname}`, {
        headers: headers(),
        signal: requestSignal(20_000),
      });
      if (response.ok) return response;
      lastError = new Error(`${pathname} returned ${response.status}`);
      if (response.status < 500) {
        lastError.retryable = false;
        throw lastError;
      }
      if (attempt === MAX_ATTEMPTS) throw lastError;
    } catch (error) {
      if (error?.retryable === false) throw error;
      if (error === lastError && attempt === MAX_ATTEMPTS) throw error;
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt === MAX_ATTEMPTS) throw lastError;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw lastError;
}

async function analyze(entry) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    await spaceAnalyzeCalls();
    try {
      const response = await fetch(`${baseUrl}/api/analyze-market`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          businessName: entry.businessName,
          businessUrl: entry.businessUrl,
          businessType: entry.businessType,
          market: entry.market,
        }),
        signal: requestSignal(75_000),
      });
      const body = await response.json().catch(() => ({}));
      if (response.ok) return { body, attempt };
      const code = errorCode(body);
      lastError = new Error(`${response.status} ${code ?? "UNKNOWN"}: ${body?.error?.message ?? body?.error ?? "analysis failed"}`);
      const retryable = response.status === 429 || (response.status === 503 && code === "SOURCE_UNAVAILABLE");
      if (retryable) recordRetryAfter(response);
      if (!retryable || attempt === MAX_ATTEMPTS) throw lastError;
    } catch (error) {
      if (error === lastError) throw error;
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt === MAX_ATTEMPTS) throw lastError;
    }
  }
  throw lastError;
}

for (const entry of catalog) {
  const row = { catalogId: entry.id, industry: entry.industry, startedAt: new Date().toISOString(), status: "running" };
  results.push(row);
  await saveProgress();
  try {
    const { body, attempt } = await analyze(entry);
    const reportStats = validateRealReport(body);
    if (typeof body.reportId !== "string" || !body.reportId) throw new Error("analysis did not persist a reportId");
    if (body.dataQuality?.cacheHit === true) throw new Error("analysis used a cached report instead of the live pipeline");

    Object.assign(row, {
      phase: "analyzed",
      attempts: attempt,
      reportId: body.reportId,
      sourceCount: reportStats.sourceCount,
      scoredEntityCount: reportStats.scoredEntityCount,
      cacheHit: body.dataQuality?.cacheHit === true,
    });
    await saveProgress();

    const storedResponse = await fetchVerification(`/api/reports/${encodeURIComponent(body.reportId)}`);
    const stored = await storedResponse.json();
    validateRealReport(stored.report ?? stored);
    row.phase = "stored-verified";
    await saveProgress();

    const sharedResponse = await fetchVerification(`/r/${encodeURIComponent(body.reportId)}`);
    validateSharedReportHtml(await sharedResponse.text(), body);

    Object.assign(row, {
      status: "passed",
      phase: "shared-verified",
      completedAt: new Date().toISOString(),
    });
  } catch (error) {
    Object.assign(row, { status: "failed", error: error instanceof Error ? error.message : String(error), completedAt: new Date().toISOString() });
  }
  await saveProgress();
}

const failed = results.filter((row) => row.status !== "passed");
console.log(`Alameda launch gate: ${results.length - failed.length}/${results.length} passed. Evidence: ${outputPath}`);
if (failed.length > 0) process.exitCode = 1;
