import crypto from "node:crypto";
import { SAMPLE_CATALOG } from "./sample-catalog";
import {
  readSampleSnapshotsV2,
  type CatalogSampleRead,
  type SampleSnapshotV2,
} from "./store";

export const SAMPLE_MAX_AGE_MS = 72 * 60 * 60 * 1000;
export const SAMPLE_MINIMUM_ACTIVE_COUNT = 10;
export const SAMPLE_PUBLIC_POOL_SIZE = 12;

export type SamplePoolHealth = {
  activeSampleCount: number;
  oldestSampleAgeHours: number | null;
  alert: boolean;
  alertReasons: Array<"ACTIVE_SAMPLE_COUNT_LOW" | "OLDEST_SAMPLE_TOO_OLD">;
};

function ageMs(snapshot: SampleSnapshotV2, now: number): number {
  return now - Date.parse(snapshot.generatedAt);
}

function retainedSnapshotsFromReads(
  reads: readonly CatalogSampleRead[],
  now: number = Date.now()
): SampleSnapshotV2[] {
  return reads
    .flatMap((read) =>
      read.outcome.status === "ok" ? [read.outcome.value] : []
    )
    .filter((snapshot) => ageMs(snapshot, now) >= 0)
    .sort((a, b) => Date.parse(b.generatedAt) - Date.parse(a.generatedAt));
}

export function activeSnapshotsFromReads(
  reads: readonly CatalogSampleRead[],
  now: number = Date.now()
): SampleSnapshotV2[] {
  return retainedSnapshotsFromReads(reads, now)
    .filter((snapshot) => ageMs(snapshot, now) <= SAMPLE_MAX_AGE_MS)
    .slice(0, SAMPLE_PUBLIC_POOL_SIZE);
}

/**
 * Prefer fresh (<72h) samples. When the active pool is empty but last-good
 * snapshots still exist, serve the freshest retained ones so the public
 * sample button does not hard-fail while refresh catches up.
 */
export function selectableSnapshotsFromReads(
  reads: readonly CatalogSampleRead[],
  now: number = Date.now()
): SampleSnapshotV2[] {
  const active = activeSnapshotsFromReads(reads, now);
  if (active.length > 0) return active;
  return retainedSnapshotsFromReads(reads, now).slice(0, SAMPLE_PUBLIC_POOL_SIZE);
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

export function samplePoolHealthFromReads(
  reads: readonly CatalogSampleRead[],
  now: number = Date.now()
): SamplePoolHealth {
  const retained = reads.flatMap((read) =>
    read.outcome.status === "ok" ? [read.outcome.value] : []
  );
  const active = activeSnapshotsFromReads(reads, now);
  const activeSampleCount = active.length;
  const ages = retained.map((snapshot) => Math.max(0, ageMs(snapshot, now)));
  const oldestSampleAgeHours =
    ages.length === 0
      ? null
      : Math.round((Math.max(...ages) / (60 * 60 * 1000)) * 100) / 100;
  const alertReasons: SamplePoolHealth["alertReasons"] = [];
  if (activeSampleCount < SAMPLE_MINIMUM_ACTIVE_COUNT) {
    alertReasons.push("ACTIVE_SAMPLE_COUNT_LOW");
  }
  if (
    oldestSampleAgeHours === null ||
    oldestSampleAgeHours > SAMPLE_MAX_AGE_MS / (60 * 60 * 1000)
  ) {
    alertReasons.push("OLDEST_SAMPLE_TOO_OLD");
  }
  return {
    activeSampleCount,
    oldestSampleAgeHours,
    alert: alertReasons.length > 0,
    alertReasons,
  };
}

export async function getSamplePoolHealth(
  now: number = Date.now()
): Promise<SamplePoolHealth> {
  const reads = await readSampleSnapshotsV2(
    SAMPLE_CATALOG.map((entry) => entry.id)
  );
  return samplePoolHealthFromReads(reads, now);
}
