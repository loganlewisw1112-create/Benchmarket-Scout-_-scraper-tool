import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addWaitlistEmail,
  getReport,
  isValidReportId,
  newReportId,
  saveReport,
} from "./store";

// These tests exercise the filesystem fallback backend (no KV env), which is
// what runs in local dev and CI.

let tmpDir: string;
const prevCacheDir = process.env.CACHE_DIR;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "scout-store-"));
  process.env.CACHE_DIR = tmpDir;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
});

afterEach(async () => {
  if (prevCacheDir === undefined) delete process.env.CACHE_DIR;
  else process.env.CACHE_DIR = prevCacheDir;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("report ids", () => {
  it("generates url-safe ids that validate", () => {
    for (let i = 0; i < 20; i++) {
      const id = newReportId();
      expect(isValidReportId(id)).toBe(true);
      expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("rejects malformed ids", () => {
    expect(isValidReportId("bad id!")).toBe(false);
    expect(isValidReportId("../etc/passwd")).toBe(false);
    expect(isValidReportId("short")).toBe(false);
  });
});

describe("saveReport / getReport (filesystem backend)", () => {
  it("round-trips a report", async () => {
    const id = await saveReport({ hello: "world", n: 42 });
    expect(isValidReportId(id)).toBe(true);
    const stored = await getReport(id);
    expect(stored).not.toBeNull();
    expect(stored?.id).toBe(id);
    expect((stored?.report as { hello: string }).hello).toBe("world");
    expect(typeof stored?.createdAt).toBe("string");
  });

  it("returns null for unknown or invalid ids", async () => {
    expect(await getReport(newReportId())).toBeNull();
    expect(await getReport("bad id!")).toBeNull();
  });
});

describe("addWaitlistEmail (filesystem backend)", () => {
  it("adds once and dedupes case-insensitively", async () => {
    expect(await addWaitlistEmail("Foo@Bar.com")).toBe("added");
    expect(await addWaitlistEmail("foo@bar.com")).toBe("exists");
    expect(await addWaitlistEmail("other@bar.com")).toBe("added");
  });
});
