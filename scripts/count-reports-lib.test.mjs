import { describe, expect, it } from "vitest";
import {
  competitorCountFromRaw,
  partitionReportKeys,
} from "./count-reports-lib.mjs";

describe("partitionReportKeys", () => {
  it("separates v2 keys from legacy without folding or double-counting", () => {
    const keys = [
      "report:v2:aaaaaa",
      "report:bbbbbb",
      "report:v2:cccccc",
      "report:dddddd",
    ];
    expect(partitionReportKeys(keys)).toEqual({
      v2: ["report:v2:aaaaaa", "report:v2:cccccc"],
      legacy: ["report:bbbbbb", "report:dddddd"],
    });
  });

  it("never counts a v2 key as legacy even though it also starts with report:", () => {
    const { v2, legacy } = partitionReportKeys(["report:v2:only"]);
    expect(v2).toEqual(["report:v2:only"]);
    expect(legacy).toEqual([]);
  });

  it("drops keys matched by a broader glob than intended", () => {
    // e.g. sample:* or a stray key an over-broad MATCH could return.
    const { v2, legacy } = partitionReportKeys([
      "sample:v2:x",
      "reportsomethingelse", // no colon: not a report:<id> key
      "report:ok",
      42,
      null,
    ]);
    expect(v2).toEqual([]);
    expect(legacy).toEqual(["report:ok"]);
  });

  it("returns empty buckets for no keys", () => {
    expect(partitionReportKeys([])).toEqual({ v2: [], legacy: [] });
  });
});

describe("competitorCountFromRaw", () => {
  it("reads summary.competitorCount from a well-formed v2 envelope", () => {
    const raw = JSON.stringify({
      schemaVersion: 2,
      id: "abc",
      createdAt: "2026-07-21T00:00:00.000Z",
      report: { summary: { competitorCount: 10 } },
    });
    expect(competitorCountFromRaw(raw)).toBe(10);
  });

  it("accepts zero as a valid count", () => {
    const raw = JSON.stringify({ report: { summary: { competitorCount: 0 } } });
    expect(competitorCountFromRaw(raw)).toBe(0);
  });

  it("returns null (unreadable), not 0, for malformed or missing data", () => {
    expect(competitorCountFromRaw("not json")).toBeNull();
    expect(competitorCountFromRaw("")).toBeNull();
    expect(competitorCountFromRaw(null)).toBeNull();
    expect(competitorCountFromRaw(JSON.stringify({ report: {} }))).toBeNull();
    expect(
      competitorCountFromRaw(
        JSON.stringify({ report: { summary: { competitorCount: "10" } } })
      )
    ).toBeNull();
    expect(
      competitorCountFromRaw(
        JSON.stringify({ report: { summary: { competitorCount: null } } })
      )
    ).toBeNull();
  });
});
