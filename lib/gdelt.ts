import type { MarketSignal } from "./types";
import { createTimedSignal, type RequestBudgetOptions } from "./time-budget";

type GdeltArticle = { title?: string; url?: string; seendate?: string };

export type NewsFetchResult = {
  status: "complete" | "unavailable";
  signals: Array<Omit<MarketSignal, "sourceIds">>;
  queryUrl: string;
  accessedAt: string;
};

const GDELT_TOPIC_CLAUSE =
  '("award" OR "expansion" OR "hiring" OR "new location" OR "lawsuit" OR "under new management" OR "acquired" OR "grand opening")';

export async function fetchNewsSignals(
  businessName: string,
  options: RequestBudgetOptions = {}
): Promise<NewsFetchResult> {
  const query = `"${businessName}" ${GDELT_TOPIC_CLAUSE}`;
  const queryUrl = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(
    query
  )}&mode=artlist&format=json&sort=datedesc&timespan=30d&maxrecords=5`;
  const unavailable = (): NewsFetchResult => ({
    status: "unavailable",
    signals: [],
    queryUrl,
    accessedAt: new Date().toISOString(),
  });
  if (options.signal?.aborted) return unavailable();
  const timed = createTimedSignal(options.signal, options.budgetMs ?? 6_000);
  try {
    const response = await fetch(queryUrl, {
      signal: timed.signal,
      headers: { "User-Agent": "BenchmarkScout/0.1" },
    });
    if (!response.ok) return unavailable();
    const text = await response.text();
    if (!text.trim()) return unavailable();
    let data: { articles?: GdeltArticle[] };
    try {
      data = JSON.parse(text) as { articles?: GdeltArticle[] };
    } catch {
      return unavailable();
    }
    const signals = (data.articles ?? [])
      .filter(
        (article): article is Required<Pick<GdeltArticle, "title" | "url">> &
          Pick<GdeltArticle, "seendate"> =>
          Boolean(article.title?.trim() && article.url?.trim())
      )
      .slice(0, 5)
      .map((article) => ({
        label: "Public news mention found",
        evidence: `Article title: "${article.title}"`,
        sourceUrl: article.url,
        sourceType: "news" as const,
        observedAt: article.seendate,
        confidence: "medium" as const,
      }));
    return {
      status: "complete",
      signals,
      queryUrl,
      accessedAt: new Date().toISOString(),
    };
  } catch {
    return unavailable();
  } finally {
    timed.cleanup();
  }
}
