import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchNewsSignals } from "./gdelt";

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
