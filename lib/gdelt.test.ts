import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchNewsSignals } from "./gdelt";

function textResponse(body: string, ok = true) {
  return { ok, text: async () => body } as Response;
}

describe("fetchNewsSignals", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps articles to MarketSignal[] capped at 5", async () => {
    const articles = Array.from({ length: 7 }, (_, i) => ({
      title: `Article ${i}`,
      url: `https://news.example.org/${i}`,
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(textResponse(JSON.stringify({ articles })))
    );

    const signals = await fetchNewsSignals("Acme Plumbing");

    expect(signals).toHaveLength(5);
    expect(signals[0].label).toBe("Public news mention found");
    expect(signals[0].evidence).toContain("Article 0");
    expect(signals[0].sourceUrl).toBe("https://news.example.org/0");
    expect(signals[0].sourceType).toBe("news");
    expect(signals[0].confidence).toBe("medium");
  });

  it("returns [] on a non-ok HTTP response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(textResponse("", false)));
    expect(await fetchNewsSignals("Acme")).toEqual([]);
  });

  it("returns [] on an empty response body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(textResponse("   ")));
    expect(await fetchNewsSignals("Acme")).toEqual([]);
  });

  it("returns [] on malformed JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(textResponse("not json")));
    expect(await fetchNewsSignals("Acme")).toEqual([]);
  });

  it("returns [] when fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("aborted")));
    expect(await fetchNewsSignals("Acme")).toEqual([]);
  });

  it("falls back to a generic evidence string when a title is missing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        textResponse(JSON.stringify({ articles: [{ url: "https://news.example.org/x" }] }))
      )
    );
    const [signal] = await fetchNewsSignals("Acme");
    expect(signal.evidence).toBe("Public news mention found.");
  });
});
