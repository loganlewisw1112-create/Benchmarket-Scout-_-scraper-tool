import crypto from "node:crypto";
import { SAMPLE_CATALOG } from "./sample-catalog";
import {
  readSampleMetas,
  readSampleSnapshotsV2,
  SAMPLE_SNAPSHOT_TTL_SECONDS,
  type CatalogSampleMetaRead,
  type CatalogSampleRead,
  type SampleSnapshotV2,
} from "./store";

export const SAMPLE_MAX_AGE_MS = 72 * 60 * 60 * 1000;
// Retained fallback never serves a snapshot older than the store TTL, so the
// filesystem backend (no TTL) and KV (30-day TTL) serve the same pool, and
// snapshots written before the TTL existed age out too.
export const SAMPLE_RETAINED_MAX_AGE_MS = SAMPLE_SNAPSHOT_TTL_SECONDS * 1000;
export const SAMPLE_MINIMUM_ACTIVE_COUNT = 10;
export const SAMPLE_PUBLIC_POOL_SIZE = 12;
export const SAMPLE_HEALTH_CACHE_MS = 30_000;

export type SamplePoolAlertReason = "ACTIVE_SAMPLES_LOW" | "SERVED_SAMPLES_STALE";

// Health measures only the pool /api/sample-report actually serves. Catalog
// coverage is reported alongside for operators but never raises an alert:
// an id that keeps failing refresh is not an outage.
export type SamplePoolHealth = {
  activeSampleCount: number;
  servedSampleCount: number;
  servingRetained: boolean;
  oldestSampleAgeHours: number | null;
  newestSampleAgeHours: number | null;
  alert: boolean;
  alertReasons: SamplePoolAlertReason[];
  catalog: {
    size: number;
    withoutFreshSnapshot: number;
    withoutFreshSnapshotIds: string[];
  };
};

type Dated = { catalogId: string; generatedAt: string };

function ageMs(item: { generatedAt: string }, now: number): number {
  return now - Date.parse(item.generatedAt);
}

function ageHours(item: { generatedAt: string }, now: number): number {
  return Math.round((Math.max(0, ageMs(item, now)) / (60 * 60 * 1000)) * 100) / 100;
}

function okValues<T>(
  reads: ReadonlyArray<{ outcome: { status: string; value?: T } }>
): T[] {
  return reads.flatMap((read) =>
    read.outcome.status === "ok" && read.outcome.value !== undefined
      ? [read.outcome.value]
      : []
  );
}

function retainedItems<T extends Dated>(items: readonly T[], now: number): T[] {
  return items
    .filter((item) => {
      const age = ageMs(item, now);
      return age >= 0 && age <= SAMPLE_RETAINED_MAX_AGE_MS;
    })
    .sort((a, b) => Date.parse(b.generatedAt) - Date.parse(a.generatedAt));
}

function activeItems<T extends Dated>(items: readonly T[], now: number): T[] {
  return retainedItems(items, now)
    .filter((item) => ageMs(item, now) <= SAMPLE_MAX_AGE_MS)
    .slice(0, SAMPLE_PUBLIC_POOL_SIZE);
}

function selectableItems<T extends Dated>(items: readonly T[], now: number): T[] {
  const active = activeItems(items, now);
  if (active.length > 0) return active;
  return retainedItems(items, now).slice(0, SAMPLE_PUBLIC_POOL_SIZE);
}

export function activeSnapshotsFromReads(
  reads: readonly CatalogSampleRead[],
  now: number = Date.now()
): SampleSnapshotV2[] {
  return activeItems(okValues(reads), now);
}

/**
 * Prefer fresh (<72h) samples. When the active pool is empty but last-good
 * snapshots (up to the retained age cap) still exist, serve the freshest
 * retained ones so the public sample button does not hard-fail while refresh
 * catches up.
 */
export function selectableSnapshotsFromReads(
  reads: readonly CatalogSampleRead[],
  now: number = Date.now()
): SampleSnapshotV2[] {
  return selectableItems(okValues(reads), now);
}

export function sampleFreshness(
  snapshot: SampleSnapshotV2,
  now: number = Date.now()
): "active" | "retained" {
  const age = ageMs(snapshot, now);
  return age >= 0 && age <= SAMPLE_MAX_AGE_MS ? "active" : "retained";
}

export async function listActiveSampleSnapshots(
  now: number = Date.now()
): Promise<SampleSnapshotV2[]> {
  const reads = await readSampleSnapshotsV2(
    SAMPLE_CATALOG.map((entry) => entry.id)
  );
  return activeSnapshotsFromReads(reads, now);
}

export async function selectRandomActiveSample(
  excludeSampleId?: string,
  now: number = Date.now()
): Promise<SampleSnapshotV2 | null> {
  const reads = await readSampleSnapshotsV2(
    SAMPLE_CATALOG.map((entry) => entry.id)
  );
  const selectable = selectableSnapshotsFromReads(reads, now).filter(
    (snapshot) => snapshot.sampleId !== excludeSampleId
  );
  if (selectable.length === 0) return null;
  return selectable[crypto.randomInt(selectable.length)] ?? null;
}

function samplePoolHealthFromItems(
  items: readonly Dated[],
  catalogIds: readonly string[],
  now: number
): SamplePoolHealth {
  const active = activeItems(items, now);
  const served = selectableItems(items, now);
  const servingRetained = active.length === 0 && served.length > 0;
  const servedAges = served.map((item) => ageHours(item, now));
  const oldestSampleAgeHours =
    servedAges.length === 0 ? null : Math.max(...servedAges);
  const newestSampleAgeHours =
    servedAges.length === 0 ? null : Math.min(...servedAges);

  const alertReasons: SamplePoolAlertReason[] = [];
  if (active.length < SAMPLE_MINIMUM_ACTIVE_COUNT) {
    alertReasons.push("ACTIVE_SAMPLES_LOW");
  }
  if (
    servingRetained ||
    (oldestSampleAgeHours !== null &&
      oldestSampleAgeHours > SAMPLE_MAX_AGE_MS / (60 * 60 * 1000))
  ) {
    alertReasons.push("SERVED_SAMPLES_STALE");
  }

  const fresh = new Set(
    items
      .filter((item) => {
        const age = ageMs(item, now);
        return age >= 0 && age <= SAMPLE_MAX_AGE_MS;
      })
      .map((item) => item.catalogId)
  );
  const withoutFreshSnapshotIds = catalogIds.filter((id) => !fresh.has(id));

  return {
    activeSampleCount: active.length,
    servedSampleCount: served.length,
    servingRetained,
    oldestSampleAgeHours,
    newestSampleAgeHours,
    alert: alertReasons.length > 0,
    alertReasons,
    catalog: {
      size: catalogIds.length,
      withoutFreshSnapshot: withoutFreshSnapshotIds.length,
      withoutFreshSnapshotIds,
    },
  };
}

export function samplePoolHealthFromReads(
  reads: readonly CatalogSampleRead[],
  now: number = Date.now()
): SamplePoolHealth {
  return samplePoolHealthFromItems(
    okValues(reads),
    reads.map((read) => read.catalogId),
    now
  );
}

export function samplePoolHealthFromMetas(
  reads: readonly CatalogSampleMetaRead[],
  now: number = Date.now()
): SamplePoolHealth {
  return samplePoolHealthFromItems(
    okValues(reads),
    reads.map((read) => read.catalogId),
    now
  );
}

// Per-instance memo: health is polled by monitors and is unauthenticated, so
// each instance does at most one metadata MGET per 30 seconds. Concurrent
// callers share the in-flight read. Failures are not cached, so a transient
// KV error does not pin health to 503 for the whole window.
let healthCache: { at: number; value: Promise<SamplePoolHealth> } | null = null;

export function resetSamplePoolHealthCache(): void {
  healthCache = null;
}

export function getSamplePoolHealth(
  now: number = Date.now()
): Promise<SamplePoolHealth> {
  if (
    healthCache &&
    now >= healthCache.at &&
    now - healthCache.at < SAMPLE_HEALTH_CACHE_MS
  ) {
    return healthCache.value;
  }
  const value = readSampleMetas(SAMPLE_CATALOG.map((entry) => entry.id)).then(
    (reads) => samplePoolHealthFromMetas(reads, now)
  );
  const entry = { at: now, value };
  healthCache = entry;
  value.catch(() => {
    if (healthCache === entry) healthCache = null;
  });
  return value;
}
