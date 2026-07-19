import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalyzeMarketResponse } from "./types";

vi.mock("./invariants", () => ({
  assertRealDataResponse: (value: AnalyzeMarketResponse) => {
    if (value.schemaVersion !== 2) throw new Error("invalid real-data report");
  },
}));

import { deleteCache, readCache, writeCache } from "./cache";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "scout-cache-"));
  process.env.CACHE_DIR = tmpDir;
});

afterEach(async () => {
  delete process.env.CACHE_DIR;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("v2 report cache", () => {
  it("validates on write and read and supports forced refresh deletion", async () => {
    const report = { schemaVersion: 2 } as AnalyzeMarketResponse;
    await writeCache("reports", "input", report);
    expect(await readCache("reports", "input")).toEqual(report);
    await deleteCache("reports", "input");
    expect(await readCache("reports", "input")).toBeNull();
  });

  it("does not write a report that violates the invariant", async () => {
    await expect(
      writeCache(
        "reports",
        "bad",
        { schemaVersion: 1 } as unknown as AnalyzeMarketResponse
      )
    ).rejects.toThrow("invalid real-data report");
    await expect(fs.readdir(path.join(tmpDir, "reports"))).rejects.toThrow();
  });
});
