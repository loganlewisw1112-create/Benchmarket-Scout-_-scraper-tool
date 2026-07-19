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

import {
  admitWaitlistEmail,
  getReport,
  isDurableStoreConfigured,
  isValidReportId,
  kvCappedRateLimit,
  newReportId,
  readReportV2,
  readSampleSnapshotsV2,
  replaceSampleSnapshot,
  saveReport,
  WAITLIST_NEW_SIGNUPS_PER_WINDOW,
} from "./store";
import { WINDOW_MS } from "./rate-limit";

const validReport = { schemaVersion: 2 } as AnalyzeMarketResponse;

// These tests exercise the filesystem fallback backend (no KV env), which is
// what runs in local dev and CI.

let tmpDir: string;
const prevCacheDir = process.env.CACHE_DIR;
const prevVercel = process.env.VERCEL;
const prevVercelEnv = process.env.VERCEL_ENV;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "scout-store-"));
  process.env.CACHE_DIR = tmpDir;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.VERCEL;
  delete process.env.VERCEL_ENV;
});

afterEach(async () => {
  vi.unstubAllGlobals();
  if (prevCacheDir === undefined) delete process.env.CACHE_DIR;
  else process.env.CACHE_DIR = prevCacheDir;
  if (prevVercel === undefined) delete process.env.VERCEL;
  else process.env.VERCEL = prevVercel;
  if (prevVercelEnv === undefined) delete process.env.VERCEL_ENV;
  else process.env.VERCEL_ENV = prevVercelEnv;
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
    const id = await saveReport(validReport);
    expect(isValidReportId(id)).toBe(true);
    const stored = await getReport(id);
    expect(stored).not.toBeNull();
    expect(stored?.id).toBe(id);
    expect(stored?.schemaVersion).toBe(2);
    expect(stored?.report.schemaVersion).toBe(2);
    expect(typeof stored?.createdAt).toBe("string");
  });

  it("returns null for unknown or invalid ids", async () => {
    expect(await getReport(newReportId())).toBeNull();
    expect(await getReport("bad id!")).toBeNull();
  });

  it("returns a typed legacy outcome without reading it as v2", async () => {
    const id = newReportId();
    const dir = path.join(tmpDir, "store", "reports");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${id}.json`), JSON.stringify({ id }));
    expect(await readReportV2(id)).toEqual({ status: "legacy" });
  });

  it("rejects an invariant violation before writing", async () => {
    await expect(
      saveReport({ schemaVersion: 1 } as unknown as AnalyzeMarketResponse)
    ).rejects.toThrow("invalid real-data report");
    await expect(
      fs.readdir(path.join(tmpDir, "store", "report-v2"))
    ).rejects.toThrow();
  });

  it("fails closed instead of using ephemeral files on a hosted deployment", async () => {
    process.env.VERCEL = "1";
    expect(isDurableStoreConfigured()).toBe(false);
    await expect(saveReport(validReport)).rejects.toThrow(
      /Durable report storage is not configured/
    );
    await expect(readReportV2(newReportId())).rejects.toThrow(
      /Durable report storage is not configured/
    );
    await expect(readReportV2("bad id!")).rejects.toThrow(
      /Durable report storage is not configured/
    );
  });

  it("does not combine credentials from different REST KV providers", async () => {
    process.env.VERCEL = "1";
    process.env.KV_REST_API_URL = "https://vercel-kv.test";
    process.env.UPSTASH_REDIS_REST_TOKEN = "upstash-token";
    expect(isDurableStoreConfigured()).toBe(false);
    await expect(saveReport(validReport)).rejects.toThrow(
      /Durable report storage is not configured/
    );

    process.env.KV_REST_API_TOKEN = "vercel-token";
    expect(isDurableStoreConfigured()).toBe(true);
  });

  it("does not treat whitespace-only REST KV values as configured", () => {
    process.env.KV_REST_API_URL = "   ";
    process.env.KV_REST_API_TOKEN = "   ";
    expect(isDurableStoreConfigured()).toBe(false);
  });
});

describe("v2 sample snapshots (filesystem backend)", () => {
  it("rejects ephemeral sample storage on a hosted deployment", async () => {
    process.env.VERCEL = "1";
    const snapshot = {
      schemaVersion: 2 as const,
      sampleId: newReportId(),
      catalogId: "bakery-firebrand-bread",
      reportId: newReportId(),
      generatedAt: new Date().toISOString(),
      report: validReport,
    };
    await expect(replaceSampleSnapshot(snapshot)).rejects.toThrow(
      /Durable report storage is not configured/
    );
    await expect(
      readSampleSnapshotsV2([snapshot.catalogId])
    ).rejects.toThrow(/Durable report storage is not configured/);
  });

  it("atomically replaces and validates a catalog snapshot", async () => {
    const first = {
      schemaVersion: 2 as const,
      sampleId: newReportId(),
      catalogId: "bakery-firebrand-bread",
      reportId: newReportId(),
      generatedAt: new Date().toISOString(),
      report: validReport,
    };
    await replaceSampleSnapshot(first);
    const second = { ...first, sampleId: newReportId() };
    await replaceSampleSnapshot(second);

    const [read] = await readSampleSnapshotsV2([first.catalogId]);
    expect(read?.outcome.status).toBe("ok");
    if (read?.outcome.status === "ok") {
      expect(read.outcome.value.sampleId).toBe(second.sampleId);
    }
    expect(await fs.readdir(path.join(tmpDir, "store", "sample-v2"))).toEqual([
      `${first.catalogId}.json`,
    ]);
  });

  it("reports missing, legacy, and invalid outcomes distinctly", async () => {
    const legacyDir = path.join(tmpDir, "store", "samples");
    const currentDir = path.join(tmpDir, "store", "sample-v2");
    await fs.mkdir(legacyDir, { recursive: true });
    await fs.mkdir(currentDir, { recursive: true });
    await fs.writeFile(path.join(legacyDir, "legacy-entry.json"), "{}");
    await fs.writeFile(path.join(currentDir, "invalid-entry.json"), "{}");

    const reads = await readSampleSnapshotsV2([
      "missing-entry",
      "legacy-entry",
      "invalid-entry",
    ]);
    expect(reads.map((read) => read.outcome.status)).toEqual([
      "missing",
      "legacy",
      "invalid",
    ]);
  });
});

describe("admitWaitlistEmail (filesystem backend)", () => {
  it("adds once, dedupes case-insensitively, and appends repeat feedback", async () => {
    expect((await admitWaitlistEmail("Foo@Bar.com")).outcome).toBe("added");
    expect(
      (
        await admitWaitlistEmail("foo@bar.com", {
          message: "Follow-up feedback",
        })
      ).outcome
    ).toBe("exists");
    expect((await admitWaitlistEmail("other@bar.com")).outcome).toBe("added");

    const raw = await fs.readFile(
      path.join(tmpDir, "store", "waitlist-entries.jsonl"),
      "utf8"
    );
    const entries = raw
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries).toHaveLength(3);
    expect(entries[1]).toMatchObject({
      email: "foo@bar.com",
      message: "Follow-up feedback",
    });
  });

  it("stores feedback in the canonical entry metadata", async () => {
    await admitWaitlistEmail("feedback@example.com", {
      source: "landing",
      message: "Please add another comparison metric.",
    });

    const raw = await fs.readFile(
      path.join(tmpDir, "store", "waitlist-entries.jsonl"),
      "utf8"
    );
    const entry = JSON.parse(raw.trim()) as Record<string, unknown>;
    expect(entry).toMatchObject({
      email: "feedback@example.com",
      source: "landing",
      message: "Please add another comparison metric.",
    });
  });
});

type MockKvState = {
  emails: Set<string>;
  entries: string[];
  counters: Map<string, number>;
  commands: unknown[][];
};

function installKvMock(): MockKvState {
  const state: MockKvState = {
    emails: new Set(),
    entries: [],
    counters: new Map(),
    commands: [],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const command = JSON.parse(String(init?.body)) as unknown[];
      state.commands.push(command);
      if (command[0] !== "EVAL") throw new Error("Expected atomic EVAL");

      const keyCount = Number(command[2]);
      let result: number[];
      if (keyCount === 3) {
        const rateKey = String(command[5]);
        const email = String(command[6]);
        const entry = String(command[7]);
        const maximum = Number(command[8]);
        if (state.emails.has(email)) {
          state.entries.push(entry);
          result = [0, 0];
        } else {
          const current = state.counters.get(rateKey) ?? 0;
          if (current >= maximum) {
            result = [2, current];
          } else {
            state.counters.set(rateKey, current + 1);
            state.emails.add(email);
            state.entries.push(entry);
            result = [1, current + 1];
          }
        }
      } else {
        const rateKey = String(command[3]);
        const maximum = Number(command[4]);
        const current = state.counters.get(rateKey) ?? 0;
        if (current >= maximum) {
          result = [0, current];
        } else {
          state.counters.set(rateKey, current + 1);
          result = [1, current + 1];
        }
      }
      return new Response(JSON.stringify({ result }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    })
  );
  return state;
}

describe("atomic KV admission", () => {
  const T0 = 1_760_000_000_000;

  beforeEach(() => {
    process.env.KV_REST_API_URL = "https://kv.test";
    process.env.KV_REST_API_TOKEN = "token";
  });

  it("admits ten, rejects the eleventh without mutation, and resets by window", async () => {
    const state = installKvMock();
    for (let i = 0; i < WAITLIST_NEW_SIGNUPS_PER_WINDOW; i++) {
      expect(
        (await admitWaitlistEmail(`person-${i}@example.com`, {}, T0)).outcome
      ).toBe("added");
    }

    const denied = await admitWaitlistEmail("person-10@example.com", {}, T0);
    expect(denied.outcome).toBe("rate_limited");
    expect(state.emails).toHaveLength(WAITLIST_NEW_SIGNUPS_PER_WINDOW);
    expect(state.entries).toHaveLength(WAITLIST_NEW_SIGNUPS_PER_WINDOW);
    expect([...state.counters.values()]).toEqual([
      WAITLIST_NEW_SIGNUPS_PER_WINDOW,
    ]);
    expect(state.commands[0]?.slice(3, 6)).toEqual([
      "waitlist:emails",
      "waitlist:entries",
      expect.stringContaining("global:waitlist:new-signups"),
    ]);
    expect(String(state.commands[0]?.[1])).toContain("SISMEMBER");
    expect(String(state.commands[0]?.[1])).toContain("RPUSH");

    const duplicate = await admitWaitlistEmail(
      "person-0@example.com",
      { message: "Repeat feedback" },
      T0
    );
    expect(duplicate.outcome).toBe("exists");
    expect(state.entries).toHaveLength(WAITLIST_NEW_SIGNUPS_PER_WINDOW + 1);
    expect([...state.counters.values()]).toEqual([
      WAITLIST_NEW_SIGNUPS_PER_WINDOW,
    ]);

    expect(
      (
        await admitWaitlistEmail(
          "person-10@example.com",
          {},
          T0 + WINDOW_MS
        )
      ).outcome
    ).toBe("added");
    expect(state.commands.every((command) => command[0] === "EVAL")).toBe(true);
  });

  it("serializes concurrent duplicate admission in one Redis operation each", async () => {
    const state = installKvMock();
    const results = await Promise.all([
      admitWaitlistEmail("race@example.com", { message: "First" }, T0),
      admitWaitlistEmail("race@example.com", { message: "Second" }, T0),
    ]);
    expect(results.map((result) => result.outcome).sort()).toEqual([
      "added",
      "exists",
    ]);
    expect(state.emails).toHaveLength(1);
    expect(state.entries).toHaveLength(2);
    expect([...state.counters.values()]).toEqual([1]);
  });

  it("does not increment a denied global KV counter", async () => {
    const state = installKvMock();
    expect((await kvCappedRateLimit("global:test", WINDOW_MS, 1, T0))?.allowed).toBe(
      true
    );
    expect((await kvCappedRateLimit("global:test", WINDOW_MS, 1, T0))?.allowed).toBe(
      false
    );
    expect((await kvCappedRateLimit("global:test", WINDOW_MS, 1, T0))?.allowed).toBe(
      false
    );
    expect([...state.counters.values()]).toEqual([1]);
  });

  it("surfaces KV failures instead of falling back to local admission", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("KV down")));
    await expect(
      admitWaitlistEmail("failure@example.com", {}, T0)
    ).rejects.toThrow("KV down");
  });
});
