import type { MarketSignal } from "./types";

type GdeltArticle = {
  title?: string;
  url?: string;
  seendate?: string;
};

const GDELT_TOPIC_CLAUSE =
  '("award" OR "expansion" OR "hiring" OR "new location" OR "lawsuit" OR "under new management" OR "acquired" OR "grand opening")';

export async function fetchNewsSignals(
  businessName: string
): Promise<MarketSignal[]> {
  const query = `"${businessName}" ${GDELT_TOPIC_CLAUSE}`;
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(
    query
  )}&mode=artlist&format=json&sort=datedesc&timespan=30d&maxrecords=5`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "BenchmarkScout/0.1" },
    });

    if (!res.ok) return [];

    const text = await res.text();
    if (!text.trim()) return [];

    let data: { articles?: GdeltArticle[] };
    try {
      data = JSON.parse(text);
    } catch {
      return [];
    }

    const articles = data.articles ?? [];

    return articles.slice(0, 5).map((article) => ({
      label: "Public news mention found",
      evidence: article.title
        ? `Article title: "${article.title}"`
        : "Public news mention found.",
      sourceUrl: article.url,
      sourceType: "news" as const,
      confidence: "medium" as const,
    }));
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}
