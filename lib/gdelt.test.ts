import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchCombinedNewsSignals, fetchNewsSignals } from "./gdelt";

function textResponse(body: string, ok = true) {
  return { ok, text: async () => body } as Response;
}

describe("fetchNewsSignals", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("maps only sourced articles, capped at five", async () => {
    const articles = Array.from({ length: 7 }, (_, index) => ({
      title: `Article ${index}`,
      url: `https://news.example.org/${index}`,
      seendate: `2026010${index + 1}T000000Z`,
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(textResponse(JSON.stringify({ articles })))
    );
    const result = await fetchNewsSignals("Acme");
    expect(result.status).toBe("complete");
    expect(result.signals).toHaveLength(5);
    expect(result.signals[0]).toMatchObject({
      sourceType: "news",
      sourceUrl: "https://news.example.org/0",
    });
  });

  it("treats a valid empty article list as complete", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(textResponse(JSON.stringify({ articles: [] })))
    );
    await expect(fetchNewsSignals("Acme")).resolves.toMatchObject({
      status: "complete",
      signals: [],
    });
  });

  it.each([
    ["HTTP failure", textResponse("", false)],
    ["empty body", textResponse("   ")],
    ["malformed JSON", textResponse("not json")],
  ])("marks %s unavailable", async (_label, response) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    await expect(fetchNewsSignals("Acme")).resolves.toMatchObject({
      status: "unavailable",
      signals: [],
    });
  });

  it("marks transport failure unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("aborted")));
    expect((await fetchNewsSignals("Acme")).status).toBe("unavailable");
  });

  it("honors an already-canceled parent budget without starting a request", async () => {
    const controller = new AbortController();
    controller.abort(new Error("request deadline"));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchNewsSignals("Acme", {
      signal: controller.signal,
      budgetMs: 3_500,
    });

    expect(result.status).toBe("unavailable");
    expect(Number.isNaN(Date.parse(result.accessedAt))).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("drops articles missing a title or URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        textResponse(
          JSON.stringify({ articles: [{ url: "https://news.example.org/x" }] })
        )
      )
    );
    await expect(fetchNewsSignals("Acme")).resolves.toMatchObject({
      status: "complete",
      signals: [],
    });
  });
});

describe("fetchCombinedNewsSignals", () => {
  afterEach(() => vi.unstubAllGlobals());

  const entities = [
    { id: "user", name: "Al's Barbershop" },
    { id: "osm-node-1", name: "Fade Kings" },
    { id: "osm-node-2", name: "Joe's" },
    { id: "osm-node-3", name: "Joe's Pizza" },
  ];

  it("sends exactly one OR-combined request with the contactable user agent", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(textResponse(JSON.stringify({ articles: [] })));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchCombinedNewsSignals(entities);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    const query = new URL(url as string).searchParams.get("query");
    expect(query).toContain(`("Al's Barbershop" OR "Fade Kings" OR "Joe's" OR "Joe's Pizza")`);
    expect((init as RequestInit).headers).toMatchObject({
      "User-Agent": expect.stringContaining("contact"),
    });
    expect(result.status).toBe("complete");
    expect(result.queried).toEqual(["user", "osm-node-1", "osm-node-2", "osm-node-3"]);
    expect(result.articlesByEntity).toEqual({
      user: [],
      "osm-node-1": [],
      "osm-node-2": [],
      "osm-node-3": [],
    });
  });

  it("attributes articles by headline name and guards against name collisions", async () => {
    const articles = [
      { title: "Als Barbershop wins neighborhood award", url: "https://n.example.org/1" },
      { title: "Joe’s Pizza opens a new location", url: "https://n.example.org/2" },
      { title: "Joe's expands hours", url: "https://n.example.org/3" },
      { title: "Fade Kings and Al's Barbershop team up", url: "https://n.example.org/4" },
      { title: "Local barbers are hiring", url: "https://n.example.org/5" },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(textResponse(JSON.stringify({ articles })))
    );

    const result = await fetchCombinedNewsSignals(entities);

    expect(result.articlesByEntity.user.map((s) => s.sourceUrl)).toEqual([
      "https://n.example.org/1",
    ]);
    // "Joe's Pizza" contains "Joe's", so the longer name wins.
    expect(result.articlesByEntity["osm-node-3"].map((s) => s.sourceUrl)).toEqual([
      "https://n.example.org/2",
    ]);
    expect(result.articlesByEntity["osm-node-2"].map((s) => s.sourceUrl)).toEqual([
      "https://n.example.org/3",
    ]);
    // Two unrelated names in one headline: ambiguous, attributed to nobody.
    expect(result.articlesByEntity["osm-node-1"]).toEqual([]);
  });

  it("does not query names that are too short or shared by two entities", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(textResponse(JSON.stringify({ articles: [] })));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchCombinedNewsSignals([
      { id: "user", name: "Acme Dental" },
      { id: "a", name: "Zo" },
      { id: "b", name: "Smile Co" },
      { id: "c", name: "Smile Co" },
    ]);

    expect(result.queried).toEqual(["user"]);
    expect(result.skipped).toEqual(["a", "b", "c"]);
    const query = new URL(fetchMock.mock.calls[0][0] as string).searchParams.get("query");
    expect(query?.startsWith(`"Acme Dental" (`)).toBe(true);
  });

  it.each([
    ["HTTP 429", textResponse("Please limit requests to one every 5 seconds", false)],
    ["plain-text query error", textResponse("The specified phrase is too short.")],
  ])("marks every queried entity unavailable on %s", async (_label, response) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    const result = await fetchCombinedNewsSignals(entities);

    expect(result.status).toBe("unavailable");
    expect(result.queried).toHaveLength(4);
    expect(result.articlesByEntity).toEqual({});
  });

  it("uses the caller's timeout budget", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          })
      )
    );
    const startedAt = Date.now();
    const result = await fetchCombinedNewsSignals(entities, { budgetMs: 50 });
    expect(result.status).toBe("unavailable");
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });
});
