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

export function activeSnapshotsFromReads(
  reads: readonly CatalogSampleRead[],
  now: number = Date.now()
): SampleSnapshotV2[] {
  return reads.flatMap((read) => {
    if (read.outcome.status !== "ok") return [];
    const age = ageMs(read.outcome.value, now);
    return age >= 0 && age <= SAMPLE_MAX_AGE_MS ? [read.outcome.value] : [];
  }).slice(0, SAMPLE_PUBLIC_POOL_SIZE);
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
  const active = (await listActiveSampleSnapshots(now)).filter(
    (snapshot) => snapshot.sampleId !== excludeSampleId
  );
  if (active.length === 0) return null;
  return active[crypto.randomInt(active.length)] ?? null;
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
