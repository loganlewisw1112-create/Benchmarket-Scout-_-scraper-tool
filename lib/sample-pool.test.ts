import { beforeEach, describe, expect, it, vi } from "vitest";

const storeMocks = vi.hoisted(() => ({ readSampleMetas: vi.fn() }));
vi.mock("./store", () => ({
  SAMPLE_SNAPSHOT_TTL_SECONDS: 60 * 60 * 24 * 30,
  readSampleMetas: storeMocks.readSampleMetas,
  readSampleSnapshotsV2: vi.fn(),
}));
import {
  activeSnapshotsFromReads,
  SAMPLE_MAX_AGE_MS,
  SAMPLE_HEALTH_CACHE_MS,
  SAMPLE_RETAINED_MAX_AGE_MS,
  getSamplePoolHealth,
  resetSamplePoolHealthCache,
  sampleFreshness,
  samplePoolHealthFromMetas,
  samplePoolHealthFromReads,
  selectableSnapshotsFromReads,
} from "./sample-pool";
import type {
  CatalogSampleMetaRead,
  CatalogSampleRead,
  SampleSnapshotV2,
} from "./store";
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

  it("alerts below ten active samples, measured over the served pool only", () => {
    const healthy = Array.from({ length: 10 }, (_, index) =>
      readAtAge(`fresh-${index}`, index + 1)
    );
    expect(samplePoolHealthFromReads(healthy, NOW)).toMatchObject({
      activeSampleCount: 10,
      servedSampleCount: 10,
      servingRetained: false,
      oldestSampleAgeHours: 10,
      newestSampleAgeHours: 1,
      alert: false,
      alertReasons: [],
    });

    const nine = healthy.slice(0, 9);
    expect(samplePoolHealthFromReads(nine, NOW)).toMatchObject({
      activeSampleCount: 9,
      alert: true,
      alertReasons: ["ACTIVE_SAMPLES_LOW"],
    });
  });

  it("does not alert on stale or missing catalog snapshots that are never served", () => {
    // Regression: a 65-day-old snapshot for an id that keeps failing refresh
    // pinned the old OLDEST_SAMPLE_TOO_OLD alert on permanently.
    const reads = [
      ...Array.from({ length: 13 }, (_, index) => readAtAge(`active-${index}`, index + 1)),
      readAtAge("retained-stale", 73),
      readAtAge("gym-from-july", 1574),
      { catalogId: "never-refreshed", outcome: { status: "missing" as const } },
    ];
    const health = samplePoolHealthFromReads(reads, NOW);
    expect(health).toMatchObject({
      activeSampleCount: 12,
      servedSampleCount: 12,
      oldestSampleAgeHours: 12,
      alert: false,
      alertReasons: [],
    });
    // Coverage is reported as info: 13 fresh ids, 3 without a fresh snapshot.
    expect(health.catalog).toEqual({
      size: 16,
      withoutFreshSnapshot: 3,
      withoutFreshSnapshotIds: ["retained-stale", "gym-from-july", "never-refreshed"],
    });
  });

  it("alerts SERVED_SAMPLES_STALE when the pool falls back to retained snapshots", () => {
    expect(samplePoolHealthFromReads([readAtAge("only-stale", 73)], NOW)).toMatchObject({
      activeSampleCount: 0,
      servedSampleCount: 1,
      servingRetained: true,
      oldestSampleAgeHours: 73,
      alert: true,
      alertReasons: ["ACTIVE_SAMPLES_LOW", "SERVED_SAMPLES_STALE"],
    });
  });

  it("reports an empty pool without a stale alert it cannot measure", () => {
    expect(samplePoolHealthFromReads([], NOW)).toMatchObject({
      activeSampleCount: 0,
      servedSampleCount: 0,
      servingRetained: false,
      oldestSampleAgeHours: null,
      alertReasons: ["ACTIVE_SAMPLES_LOW"],
    });
  });

  it("computes the same health from metadata records as from full snapshots", () => {
    const reads = [readAtAge("a", 2), readAtAge("b", 80), readAtAge("c", 5)];
    const metas: CatalogSampleMetaRead[] = reads.map((read) =>
      read.outcome.status === "ok"
        ? {
            catalogId: read.catalogId,
            outcome: {
              status: "ok",
              value: {
                schemaVersion: 2,
                catalogId: read.catalogId,
                sampleId: read.outcome.value.sampleId,
                reportId: read.outcome.value.reportId,
                generatedAt: read.outcome.value.generatedAt,
              },
            },
          }
        : { catalogId: read.catalogId, outcome: { status: "missing" } }
    );
    expect(samplePoolHealthFromMetas(metas, NOW)).toEqual(
      samplePoolHealthFromReads(reads, NOW)
    );
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

  it("never serves a retained snapshot older than the store TTL", () => {
    const ttlHours = SAMPLE_RETAINED_MAX_AGE_MS / (60 * 60 * 1000);
    expect(ttlHours).toBe(30 * 24);
    const reads = [readAtAge("within-ttl", ttlHours - 1), readAtAge("past-ttl", ttlHours + 1)];
    expect(selectableSnapshotsFromReads(reads, NOW).map((item) => item.catalogId)).toEqual([
      "within-ttl",
    ]);
    expect(selectableSnapshotsFromReads([readAtAge("past-ttl", ttlHours + 1)], NOW)).toEqual([]);
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

describe("getSamplePoolHealth memo", () => {
  beforeEach(() => {
    resetSamplePoolHealthCache();
    storeMocks.readSampleMetas.mockReset();
  });

  it("reads metadata once per 30 seconds per instance and shares in-flight reads", async () => {
    storeMocks.readSampleMetas.mockResolvedValue([]);
    await Promise.all([getSamplePoolHealth(NOW), getSamplePoolHealth(NOW)]);
    await getSamplePoolHealth(NOW + SAMPLE_HEALTH_CACHE_MS - 1);
    expect(storeMocks.readSampleMetas).toHaveBeenCalledTimes(1);
    await getSamplePoolHealth(NOW + SAMPLE_HEALTH_CACHE_MS);
    expect(storeMocks.readSampleMetas).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failed store read", async () => {
    storeMocks.readSampleMetas.mockRejectedValueOnce(new Error("KV down"));
    await expect(getSamplePoolHealth(NOW)).rejects.toThrow("KV down");
    storeMocks.readSampleMetas.mockResolvedValueOnce([]);
    await expect(getSamplePoolHealth(NOW + 1)).resolves.toMatchObject({
      activeSampleCount: 0,
    });
    expect(storeMocks.readSampleMetas).toHaveBeenCalledTimes(2);
  });
});
