import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Network-free coverage of the robots.txt fetch path: DNS pinning and the
// cache are mocked, and global fetch is stubbed per test.
const mocks = vi.hoisted(() => ({
  createPinnedHttpTarget: vi.fn(),
  readCache: vi.fn(),
  writeCache: vi.fn(),
  close: vi.fn(),
}));

vi.mock("./url-safety", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./url-safety")>()),
  createPinnedHttpTarget: mocks.createPinnedHttpTarget,
}));
vi.mock("./cache", () => ({
  CACHE_TTL: { robots: 1000 },
  readCache: mocks.readCache,
  writeCache: mocks.writeCache,
}));

import { isPathAllowed } from "./robots";

const encoder = new TextEncoder();

beforeEach(() => {
  process.env.STRICT_ROBOTS = "true";
  vi.clearAllMocks();
  mocks.readCache.mockResolvedValue(null);
  mocks.writeCache.mockResolvedValue(undefined);
  mocks.close.mockResolvedValue(undefined);
  mocks.createPinnedHttpTarget.mockResolvedValue({
    dispatcher: {},
    close: mocks.close,
  });
});

afterEach(() => {
  delete process.env.STRICT_ROBOTS;
  vi.unstubAllGlobals();
});

describe("isPathAllowed robots.txt fetch", () => {
  it("reads at most 512 KiB of an endless body and cancels the stream", async () => {
    const chunk = encoder.encode(`# ${"x".repeat(1022)}\n`);
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        if (pulls === 1) {
          controller.enqueue(encoder.encode("User-agent: *\nDisallow: /blocked\n"));
          return;
        }
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body)));

    await expect(isPathAllowed("https://site.example/blocked/page")).resolves.toBe(false);

    expect(cancelled).toBe(true);
    // ~512 chunks of 1 KiB, never the unbounded stream.
    expect(pulls).toBeLessThan(600);
    const cached = mocks.writeCache.mock.calls[0][2] as { content: string };
    expect(encoder.encode(cached.content).byteLength).toBeLessThanOrEqual(512 * 1024);
    expect(mocks.close).toHaveBeenCalled();
  });

  it("passes the caller's abort signal through and does not cache an aborted lookup", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason)
          );
          controller.abort();
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      isPathAllowed("https://slow.example/page", controller.signal)
    ).resolves.toBe(true);

    const pinnedSignal = mocks.createPinnedHttpTarget.mock.calls[0][1] as AbortSignal;
    expect(pinnedSignal.aborted).toBe(true);
    expect(mocks.writeCache).not.toHaveBeenCalled();
  });

  it("caches an unavailable robots.txt as fail-open", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("nope", { status: 404 }))
    );
    await expect(isPathAllowed("https://none.example/x")).resolves.toBe(true);
    expect(mocks.writeCache).toHaveBeenCalledWith(
      "robots",
      "robots:https://none.example",
      { fetched: false, content: "" }
    );
  });

  it("treats a 5xx robots.txt as a complete disallow without caching it (RFC 9309)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("down", { status: 503 }))
    );
    await expect(isPathAllowed("https://flaky.example/x")).resolves.toBe(false);
    expect(mocks.writeCache).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalled();
  });
});
