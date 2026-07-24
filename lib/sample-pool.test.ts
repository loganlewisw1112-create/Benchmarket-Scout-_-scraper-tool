import { describe, expect, it } from "vitest";
import {
  activeSnapshotsFromReads,
  SAMPLE_MAX_AGE_MS,
  sampleFreshness,
  samplePoolHealthFromReads,
  selectableSnapshotsFromReads,
} from "./sample-pool";
import type { CatalogSampleRead, SampleSnapshotV2 } from "./store";
import type { AnalyzeMarketResponse } from "./types";

const NOW = Date.parse("2026-07-19T12:00:00.000Z");

function readAtAge(id: string, ageHours: number): CatalogSampleRead {
  const snapshot: SampleSnapshotV2 = {
    schemaVersion: 2,
    sampleId: `sample-${id}`,
    catalogId: id,
    reportId: `report-${id}`,
    generatedAt: new Date(NOW - ageHours * 60 * 60 * 1000).toISOString(),
    report: {} as AnalyzeMarketResponse,
  };
  return { catalogId: id, outcome: { status: "ok", value: snapshot } };
}

describe("real sample pool", () => {
  it("expires snapshots logically after 72 hours without deleting last-good data", () => {
    const reads = [readAtAge("fresh-one", 4), readAtAge("edge-one", 72), readAtAge("stale-one", 73)];
    expect(activeSnapshotsFromReads(reads, NOW).map((item) => item.catalogId)).toEqual([
      "fresh-one",
      "edge-one",
    ]);
    expect(SAMPLE_MAX_AGE_MS).toBe(72 * 60 * 60 * 1000);
    expect(reads[2]?.outcome.status).toBe("ok");
  });

  it("caps the public pool at 12 and substitutes the next fresh catalog entry", () => {
    const thirteenFresh = Array.from({ length: 13 }, (_, index) =>
      readAtAge(`catalog-${index}`, index + 1)
    );
    expect(activeSnapshotsFromReads(thirteenFresh, NOW)).toHaveLength(12);
    const withExpiredFirst = [readAtAge("catalog-expired", 73), ...thirteenFresh];
    const selected = activeSnapshotsFromReads(withExpiredFirst, NOW);
    expect(selected).toHaveLength(12);
    expect(selected[0]?.catalogId).toBe("catalog-0");
    expect(selected[11]?.catalogId).toBe("catalog-11");
  });

  it("alerts below ten active samples or when the oldest retained sample is stale", () => {
    const healthy = Array.from({ length: 10 }, (_, index) =>
      readAtAge(`fresh-${index}`, index + 1)
    );
    expect(samplePoolHealthFromReads(healthy, NOW)).toMatchObject({
      activeSampleCount: 10,
      oldestSampleAgeHours: 10,
      alert: false,
    });

    const staleBackup = [...healthy, readAtAge("retained-stale", 73)];
    expect(samplePoolHealthFromReads(staleBackup, NOW)).toMatchObject({
      activeSampleCount: 10,
      oldestSampleAgeHours: 73,
      alert: true,
      alertReasons: ["OLDEST_SAMPLE_TOO_OLD"],
    });

    expect(samplePoolHealthFromReads([readAtAge("only-stale", 73)], NOW)).toMatchObject({
      activeSampleCount: 0,
      oldestSampleAgeHours: 73,
      alert: true,
      alertReasons: ["ACTIVE_SAMPLE_COUNT_LOW", "OLDEST_SAMPLE_TOO_OLD"],
    });
  });

  it("keeps the active count capped at 12 while alerting on a retained stale snapshot", () => {
    const reads = [
      ...Array.from({ length: 13 }, (_, index) =>
        readAtAge(`active-${index}`, index + 1)
      ),
      readAtAge("retained-stale", 73),
    ];
    expect(samplePoolHealthFromReads(reads, NOW)).toMatchObject({
      activeSampleCount: 12,
      oldestSampleAgeHours: 73,
      alert: true,
      alertReasons: ["OLDEST_SAMPLE_TOO_OLD"],
    });
  });

  it("falls back to freshest retained snapshots when the active pool is empty", () => {
    const reads = [
      readAtAge("stale-newer", 80),
      readAtAge("stale-older", 100),
      { catalogId: "broken", outcome: { status: "missing" as const } },
    ];
    expect(activeSnapshotsFromReads(reads, NOW)).toHaveLength(0);
    expect(selectableSnapshotsFromReads(reads, NOW).map((item) => item.catalogId)).toEqual([
      "stale-newer",
      "stale-older",
    ]);
  });

  it("prefers active snapshots over retained stale ones when both exist", () => {
    const reads = [readAtAge("fresh", 4), readAtAge("stale", 90)];
    expect(selectableSnapshotsFromReads(reads, NOW).map((item) => item.catalogId)).toEqual([
      "fresh",
    ]);
  });

  it("labels freshness as active or retained by age", () => {
    const active = readAtAge("fresh", 4).outcome;
    const retained = readAtAge("stale", 90).outcome;
    expect(active.status).toBe("ok");
    expect(retained.status).toBe("ok");
    if (active.status === "ok") {
      expect(sampleFreshness(active.value, NOW)).toBe("active");
    }
    if (retained.status === "ok") {
      expect(sampleFreshness(retained.value, NOW)).toBe("retained");
    }
  });
});
