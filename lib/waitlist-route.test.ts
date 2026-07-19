import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/waitlist/route";
import { WINDOW_MS } from "./rate-limit";
import { WAITLIST_NEW_SIGNUPS_PER_WINDOW } from "./store";

let tmpDir: string;

function waitlistRequest(
  email: string,
  ip: string,
  message?: string
): Request {
  return new Request("https://scout.test/api/waitlist", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-forwarded-for": ip,
    },
    body: JSON.stringify({ email, message }),
  });
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "scout-waitlist-route-"));
  process.env.CACHE_DIR = tmpDir;
  delete process.env.SCOUT_API_KEY;
  delete process.env.SCOUT_API_KEY_HASH;
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete process.env.CACHE_DIR;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("POST /api/waitlist", () => {
  it("stores ten new signups, rejects the eleventh, and lets duplicates submit feedback", async () => {
    const windowStart = Math.floor(1_770_000_000_000 / WINDOW_MS) * WINDOW_MS;
    vi.useFakeTimers();
    vi.setSystemTime(windowStart + WINDOW_MS - 1_000);

    for (let i = 0; i < WAITLIST_NEW_SIGNUPS_PER_WINDOW; i++) {
      const response = await POST(
        waitlistRequest(`route-${i}@example.com`, `203.0.113.${i + 1}`)
      );
      expect(response.status).toBe(200);
    }

    const denied = await POST(
      waitlistRequest("route-10@example.com", "203.0.113.20")
    );
    expect(denied.status).toBe(429);
    expect(denied.headers.get("Retry-After")).toBe("1");

    const duplicate = await POST(
      waitlistRequest(
        "route-0@example.com",
        "203.0.113.21",
        "The map needs clearer labels."
      )
    );
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({
      status: "exists",
      message: "You are already on the list, and your feedback was saved.",
    });

    const emails = JSON.parse(
      await fs.readFile(
        path.join(tmpDir, "store", "waitlist-emails.json"),
        "utf8"
      )
    ) as string[];
    const entries = (
      await fs.readFile(
        path.join(tmpDir, "store", "waitlist-entries.jsonl"),
        "utf8"
      )
    )
      .trim()
      .split(/\r?\n/);
    expect(emails).toHaveLength(WAITLIST_NEW_SIGNUPS_PER_WINDOW);
    expect(entries).toHaveLength(WAITLIST_NEW_SIGNUPS_PER_WINDOW + 1);
    expect(JSON.parse(entries.at(-1) ?? "{}")).toMatchObject({
      email: "route-0@example.com",
      message: "The map needs clearer labels.",
    });

    vi.setSystemTime(windowStart + WINDOW_MS);
    const nextWindow = await POST(
      waitlistRequest("route-10@example.com", "203.0.113.22")
    );
    expect(nextWindow.status).toBe(200);
  });

  it("counts concurrent duplicate submissions as one new signup", async () => {
    const windowStart =
      Math.floor(1_770_000_300_000 / WINDOW_MS) * WINDOW_MS;
    vi.useFakeTimers();
    vi.setSystemTime(windowStart);

    const concurrent = await Promise.all([
      POST(
        waitlistRequest(
          "concurrent@example.com",
          "198.51.100.1",
          "First note"
        )
      ),
      POST(
        waitlistRequest(
          "concurrent@example.com",
          "198.51.100.2",
          "Second note"
        )
      ),
    ]);
    expect(concurrent.map((response) => response.status)).toEqual([200, 200]);
    const payloads = await Promise.all(
      concurrent.map(
        async (response) =>
          (await response.json()) as { status: string; message: string }
      )
    );
    expect(payloads.map((payload) => payload.status).sort()).toEqual([
      "added",
      "exists",
    ]);
    expect(
      payloads.every((payload) => payload.message.includes("feedback was saved"))
    ).toBe(true);

    for (let i = 0; i < WAITLIST_NEW_SIGNUPS_PER_WINDOW - 1; i++) {
      expect(
        (
          await POST(
            waitlistRequest(
              `concurrent-${i}@example.com`,
              `198.51.100.${i + 10}`
            )
          )
        ).status
      ).toBe(200);
    }
    expect(
      (
        await POST(
          waitlistRequest("over-cap@example.com", "198.51.100.50")
        )
      ).status
    ).toBe(429);
  });

  it("returns a retryable 503 when configured KV fails", async () => {
    process.env.KV_REST_API_URL = "https://kv.test";
    process.env.KV_REST_API_TOKEN = "token";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("KV down")));

    const response = await POST(
      waitlistRequest("kv-failure@example.com", "192.0.2.44")
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining("temporarily unavailable"),
    });
  });
});
