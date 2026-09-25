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
  KV_REQUEST_TIMEOUT_MS,
  kvCappedRateLimit,
  kvRateLimit,
  kvRateLimitCount,
  newReportId,
  readReportV2,
  readSampleMetas,
  readSampleSnapshotsV2,
  replaceSampleSnapshot,
  SAMPLE_SNAPSHOT_TTL_SECONDS,
  saveReport,
  WAITLIST_NEW_SIGNUPS_PER_WINDOW,
  WAITLIST_TTL_SECONDS,
} from "./store";
import { WINDOW_MS } from "./rate-limit";

const validReport = { schemaVersion: 2 } as AnalyzeMarketResponse;

// These tests exercise the filesystem fallback backend (no KV env), which is
// what runs in local dev and CI.

let tmpDir: string;
const prevCacheDir = process.env.CACHE_DIR;
const prevVercel = process.env.VERCEL;
const prevVercelEnv = process.env.VERCEL_ENV;
const prevAllowPreviewKv = process.env.ALLOW_PREVIEW_KV;

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
  if (prevAllowPreviewKv === undefined) delete process.env.ALLOW_PREVIEW_KV;
  else process.env.ALLOW_PREVIEW_KV = prevAllowPreviewKv;
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

  it("reports missing and invalid outcomes; pre-v2 files read as missing", async () => {
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
      "missing",
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

describe("REST KV request timeout", () => {
  it("applies a 1.5-second abort signal to every hosted KV fetch", async () => {
    process.env.KV_REST_API_URL = "https://kv.test";
    process.env.KV_REST_API_TOKEN = "token";
    const controller = new AbortController();
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(controller.signal);
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => {
        void _input;
        void _init;
        return new Response(JSON.stringify({ result: 1 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
    );
    vi.stubGlobal("fetch", fetchMock);

    await kvRateLimit("timeout-test", WINDOW_MS, 10);

    expect(KV_REQUEST_TIMEOUT_MS).toBe(1_500);
    expect(timeout).toHaveBeenCalledTimes(1);
    expect(timeout).toHaveBeenNthCalledWith(1, KV_REQUEST_TIMEOUT_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.signal).toBe(controller.signal);
    }
  });
});

function sampleSnapshot(catalogId: string, generatedAt = new Date().toISOString()) {
  return {
    schemaVersion: 2 as const,
    sampleId: newReportId(),
    catalogId,
    reportId: newReportId(),
    generatedAt,
    report: validReport,
  };
}

// Minimal Redis-over-REST emulation for GET/SET/MGET plus the store's EVAL
// scripts, recording every command and each key's TTL.
function installGenericKvMock() {
  const data = new Map<string, string>();
  const ttls = new Map<string, number>();
  const commands: unknown[][] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const command = JSON.parse(String(init?.body)) as unknown[];
      commands.push(command);
      let result: unknown = null;
      const [name] = command;
      if (name === "MGET") {
        result = command.slice(1).map((key) => data.get(String(key)) ?? null);
      } else if (name === "GET") {
        result = data.get(String(command[1])) ?? null;
      } else if (name === "SET") {
        data.set(String(command[1]), String(command[2]));
        if (command[3] === "EX") ttls.set(String(command[1]), Number(command[4]));
        result = "OK";
      } else if (name === "EVAL") {
        const script = String(command[1]);
        if (script.includes("'SET'")) {
          // SAMPLE_SNAPSHOT_WRITE_SCRIPT: KEYS[1..2], ARGV[1..3]
          const [k1, k2, v1, v2, ttl] = command.slice(3).map(String);
          data.set(k1!, v1!);
          data.set(k2!, v2!);
          ttls.set(k1!, Number(ttl));
          ttls.set(k2!, Number(ttl));
          result = 1;
        } else {
          // FIXED_WINDOW_COUNTER_SCRIPT
          const key = String(command[3]);
          const next = Number(data.get(key) ?? "0") + 1;
          data.set(key, String(next));
          if (!ttls.has(key)) ttls.set(key, Number(command[4]));
          result = next;
        }
      } else {
        throw new Error(`unexpected command ${String(name)}`);
      }
      return new Response(JSON.stringify({ result }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    })
  );
  return { data, ttls, commands };
}

describe("sample snapshot TTL and metadata (KV backend)", () => {
  beforeEach(() => {
    process.env.KV_REST_API_URL = "https://kv.test";
    process.env.KV_REST_API_TOKEN = "token";
  });

  it("writes the snapshot and its metadata atomically with a 30-day TTL", async () => {
    const kv = installGenericKvMock();
    const snapshot = sampleSnapshot("bakery-firebrand-bread");
    await replaceSampleSnapshot(snapshot);

    expect(kv.commands).toHaveLength(1);
    expect(kv.commands[0]?.[0]).toBe("EVAL");
    expect(SAMPLE_SNAPSHOT_TTL_SECONDS).toBe(30 * 24 * 60 * 60);
    expect(kv.ttls.get("sample:v2:bakery-firebrand-bread")).toBe(SAMPLE_SNAPSHOT_TTL_SECONDS);
    expect(kv.ttls.get("sample:v2:meta:bakery-firebrand-bread")).toBe(
      SAMPLE_SNAPSHOT_TTL_SECONDS
    );
    expect(JSON.parse(kv.data.get("sample:v2:meta:bakery-firebrand-bread")!)).toEqual({
      schemaVersion: 2,
      catalogId: snapshot.catalogId,
      sampleId: snapshot.sampleId,
      reportId: snapshot.reportId,
      generatedAt: snapshot.generatedAt,
    });
  });

  it("reads metadata with a single MGET, never touching snapshot bodies", async () => {
    const kv = installGenericKvMock();
    await replaceSampleSnapshot(sampleSnapshot("bakery-firebrand-bread"));
    await replaceSampleSnapshot(sampleSnapshot("cafe-wescafe"));
    kv.commands.length = 0;
    kv.data.set("sample:v2:meta:broken-entry", "{}");

    const reads = await readSampleMetas([
      "bakery-firebrand-bread",
      "cafe-wescafe",
      "broken-entry",
    ]);
    expect(reads.map((read) => read.outcome.status)).toEqual(["ok", "ok", "invalid"]);
    expect(kv.commands).toEqual([
      [
        "MGET",
        "sample:v2:meta:bakery-firebrand-bread",
        "sample:v2:meta:cafe-wescafe",
        "sample:v2:meta:broken-entry",
      ],
    ]);
  });

  it("falls back to the snapshot for pre-metadata entries and backfills the metadata", async () => {
    const kv = installGenericKvMock();
    const tenDaysMs = 10 * 24 * 60 * 60 * 1000;
    const generatedAt = new Date(Date.now() - tenDaysMs).toISOString();
    const olderWrite = sampleSnapshot("gym-alameda-fitness", generatedAt);
    kv.data.set("sample:v2:gym-alameda-fitness", JSON.stringify(olderWrite));

    const first = await readSampleMetas(["gym-alameda-fitness", "never-refreshed"]);
    expect(first[0]?.outcome).toMatchObject({ status: "ok", value: { generatedAt } });
    expect(first[1]?.outcome.status).toBe("missing");
    expect(kv.commands.map((command) => command[0])).toEqual(["MGET", "MGET", "SET"]);
    // The backfilled record expires with the snapshot's age window
    // (generatedAt + 30 days), not a fresh 30 days from now.
    const ttl = kv.ttls.get("sample:v2:meta:gym-alameda-fitness")!;
    expect(ttl).toBeGreaterThan(SAMPLE_SNAPSHOT_TTL_SECONDS - tenDaysMs / 1000 - 60);
    expect(ttl).toBeLessThanOrEqual(SAMPLE_SNAPSHOT_TTL_SECONDS - tenDaysMs / 1000 + 1);

    kv.commands.length = 0;
    const second = await readSampleMetas(["gym-alameda-fitness"]);
    expect(second[0]?.outcome.status).toBe("ok");
    expect(kv.commands.map((command) => command[0])).toEqual(["MGET"]);
  });

  it("backfills a snapshot already past its age window with a full TTL", async () => {
    const kv = installGenericKvMock();
    // Pre-TTL snapshot (no expiry in Redis), like the 2026-07-20 gym entry.
    const stale = sampleSnapshot("gym-alameda-fitness", "2026-07-20T12:28:20.000Z");
    kv.data.set("sample:v2:gym-alameda-fitness", JSON.stringify(stale));

    const reads = await readSampleMetas(["gym-alameda-fitness"]);
    expect(reads[0]?.outcome).toMatchObject({
      status: "ok",
      value: { generatedAt: "2026-07-20T12:28:20.000Z" },
    });
    expect(kv.commands.map((command) => command[0])).toEqual(["MGET", "MGET", "SET"]);
    expect(kv.ttls.get("sample:v2:meta:gym-alameda-fitness")).toBe(
      SAMPLE_SNAPSHOT_TTL_SECONDS
    );
  });

  it("reads served snapshots with one MGET and no legacy second read", async () => {
    const kv = installGenericKvMock();
    const reads = await readSampleSnapshotsV2(["missing-one", "missing-two"]);
    expect(reads.map((read) => read.outcome.status)).toEqual(["missing", "missing"]);
    expect(kv.commands).toEqual([
      ["MGET", "sample:v2:missing-one", "sample:v2:missing-two"],
    ]);
  });
});

describe("sample metadata (filesystem backend)", () => {
  it("writes metadata beside the snapshot and backfills it for older snapshots", async () => {
    await replaceSampleSnapshot(sampleSnapshot("bakery-firebrand-bread"));
    expect(await fs.readdir(path.join(tmpDir, "store", "sample-v2-meta"))).toEqual([
      "bakery-firebrand-bread.json",
    ]);

    await fs.writeFile(
      path.join(tmpDir, "store", "sample-v2", "cafe-wescafe.json"),
      JSON.stringify(sampleSnapshot("cafe-wescafe"))
    );
    const reads = await readSampleMetas(["bakery-firebrand-bread", "cafe-wescafe"]);
    expect(reads.map((read) => read.outcome.status)).toEqual(["ok", "ok"]);
    expect(
      (await fs.readdir(path.join(tmpDir, "store", "sample-v2-meta"))).sort()
    ).toEqual(["bakery-firebrand-bread.json", "cafe-wescafe.json"]);
  });
});

describe("atomic fixed-window counter", () => {
  beforeEach(() => {
    process.env.KV_REST_API_URL = "https://kv.test";
    process.env.KV_REST_API_TOKEN = "token";
  });

  it("increments and arms the expiry in one EVAL", async () => {
    const kv = installGenericKvMock();
    const T0 = 1_760_000_000_000;
    expect((await kvRateLimit("ip:analyze:1.2.3.4", WINDOW_MS, 2, T0))?.allowed).toBe(true);
    expect((await kvRateLimit("ip:analyze:1.2.3.4", WINDOW_MS, 2, T0))?.allowed).toBe(true);
    const third = await kvRateLimit("ip:analyze:1.2.3.4", WINDOW_MS, 2, T0);
    expect(third).toMatchObject({ allowed: false, remaining: 0 });
    expect(kv.commands).toHaveLength(3);
    for (const command of kv.commands) {
      expect(command[0]).toBe("EVAL");
      expect(String(command[1])).toContain("INCR");
      expect(String(command[1])).toContain("PEXPIRE");
      expect(command[4]).toBe(WINDOW_MS);
    }
    expect(kv.commands[0]?.[3]).toBe(
      `rl:ip:analyze:1.2.3.4:${Math.floor(T0 / WINDOW_MS)}`
    );
  });

  it("peeks at the counter with a GET that never increments it", async () => {
    const kv = installGenericKvMock();
    const T0 = 1_760_000_000_000;
    expect(await kvRateLimitCount("ip:refresh-auth:1.2.3.4", WINDOW_MS, T0)).toMatchObject({
      count: 0,
    });
    await kvRateLimit("ip:refresh-auth:1.2.3.4", WINDOW_MS, 10, T0);
    await kvRateLimit("ip:refresh-auth:1.2.3.4", WINDOW_MS, 10, T0);
    expect(await kvRateLimitCount("ip:refresh-auth:1.2.3.4", WINDOW_MS, T0)).toMatchObject({
      count: 2,
    });
    expect(await kvRateLimitCount("ip:refresh-auth:1.2.3.4", WINDOW_MS, T0)).toMatchObject({
      count: 2,
    });
    expect(kv.commands.filter((command) => command[0] === "GET")).toEqual([
      ["GET", `rl:ip:refresh-auth:1.2.3.4:${Math.floor(T0 / WINDOW_MS)}`],
      ["GET", `rl:ip:refresh-auth:1.2.3.4:${Math.floor(T0 / WINDOW_MS)}`],
      ["GET", `rl:ip:refresh-auth:1.2.3.4:${Math.floor(T0 / WINDOW_MS)}`],
    ]);
  });
});

describe("waitlist retention", () => {
  it("re-arms a 365-day TTL on the waitlist keys with every admission", async () => {
    process.env.KV_REST_API_URL = "https://kv.test";
    process.env.KV_REST_API_TOKEN = "token";
    const state = installKvMock();
    await admitWaitlistEmail("ttl@example.com", {}, 1_760_000_000_000);
    const command = state.commands[0]!;
    expect(WAITLIST_TTL_SECONDS).toBe(365 * 24 * 60 * 60);
    expect(command.at(-1)).toBe(WAITLIST_TTL_SECONDS);
    const script = String(command[1]);
    // Both the "exists" and the "added" branches re-arm both keys.
    expect(script.split("redis.call('EXPIRE', KEYS[1], tonumber(ARGV[5]))")).toHaveLength(3);
    expect(script.split("redis.call('EXPIRE', KEYS[2], tonumber(ARGV[5]))")).toHaveLength(3);
  });
});

describe("preview KV guard", () => {
  beforeEach(() => {
    process.env.KV_REST_API_URL = "https://kv.test";
    process.env.KV_REST_API_TOKEN = "token";
  });

  it("treats KV as unconfigured on a preview and uses the filesystem store", async () => {
    process.env.VERCEL_ENV = "preview";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(isDurableStoreConfigured()).toBe(false);
    const id = await saveReport(validReport);
    expect((await getReport(id))?.id).toBe(id);
    expect(await kvRateLimit("ip:analyze:1.2.3.4", WINDOW_MS, 10)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await fs.readdir(path.join(tmpDir, "store", "report-v2"))).toEqual([
      `${id}.json`,
    ]);
    warn.mockRestore();
  });

  it("uses KV on a preview only with ALLOW_PREVIEW_KV=true", () => {
    process.env.VERCEL_ENV = "preview";
    process.env.ALLOW_PREVIEW_KV = "true";
    expect(isDurableStoreConfigured()).toBe(true);
  });

  it("leaves production KV selection unchanged", () => {
    process.env.VERCEL_ENV = "production";
    expect(isDurableStoreConfigured()).toBe(true);
  });
});
