import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  admitWaitlistEmail,
  getReport,
  isValidReportId,
  kvCappedRateLimit,
  newReportId,
  saveReport,
  WAITLIST_NEW_SIGNUPS_PER_WINDOW,
} from "./store";
import { WINDOW_MS } from "./rate-limit";

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
  vi.unstubAllGlobals();
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
