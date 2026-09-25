import type { MarketSignal } from "./types";
import { createTimedSignal, type RequestBudgetOptions } from "./time-budget";

type GdeltArticle = { title?: string; url?: string; seendate?: string };

export type NewsSignal = Omit<MarketSignal, "sourceIds">;

export type NewsFetchResult = {
  status: "complete" | "unavailable";
  signals: NewsSignal[];
  queryUrl: string;
  accessedAt: string;
};

export type NewsEntity = { id: string; name: string };

/**
 * Contract 7. One combined DOC API request covers every queried entity:
 *   - "complete" + entity in `articlesByEntity` with items: news available;
 *   - "complete" + empty list: GDELT answered and nothing matched that name;
 *   - "unavailable": the request failed, so no queried entity has news data;
 *   - entities in `skipped` were not queried (name too short or colliding
 *     with another entity), so their news is "not_requested".
 */
export type CombinedNewsResult = {
  status: "complete" | "unavailable";
  queryUrl: string;
  accessedAt: string;
  queried: string[];
  skipped: string[];
  articlesByEntity: Record<string, NewsSignal[]>;
};

const USER_AGENT =
  process.env.APP_USER_AGENT ??
  "BenchmarkScout/0.1 (contact: github.com/loganlewisw1112-create/Benchmarket-Scout-_-scraper-tool)";

const GDELT_DOC_URL = "https://api.gdeltproject.org/api/v2/doc/doc";
const GDELT_TOPIC_CLAUSE =
  '("award" OR "expansion" OR "hiring" OR "new location" OR "lawsuit" OR "under new management" OR "acquired" OR "grand opening")';
// GDELT rejects very short phrases, and short names collide with ordinary
// words in headlines, so such names are not queried at all.
const MIN_NAME_CHARS = 4;
const MAX_SIGNALS_PER_ENTITY = 5;
const COMBINED_MAX_RECORDS = 75;
// GDELT's DOC API commonly needs ~11 s to answer and allows one request per
// 5 s per client, so the whole analysis makes exactly one request.
export const DEFAULT_NEWS_TIMEOUT_MS = 11_000;

function normalizeForMatch(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’‘`´"“”]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function queryPhrase(name: string): string {
  return name.replace(/["“”]/g, "").replace(/\s+/g, " ").trim();
}

function toSignal(article: { title: string; url: string; seendate?: string }): NewsSignal {
  return {
    label: "Public news mention found",
    evidence: `Article title: "${article.title}"`,
    sourceUrl: article.url,
    sourceType: "news",
    observedAt: article.seendate,
    confidence: "medium",
  };
}

function parseArticles(text: string): GdeltArticle[] | null {
  if (!text.trim()) return null;
  try {
    const data = JSON.parse(text) as { articles?: GdeltArticle[] };
    if (!data || typeof data !== "object") return null;
    return Array.isArray(data.articles) ? data.articles : [];
  } catch {
    // GDELT reports query errors as a plain-text HTTP 200 body.
    return null;
  }
}

function usableArticles(articles: GdeltArticle[]) {
  return articles.filter(
    (article): article is Required<Pick<GdeltArticle, "title" | "url">> &
      Pick<GdeltArticle, "seendate"> =>
      Boolean(article.title?.trim() && /^https?:\/\//i.test(article.url?.trim() ?? ""))
  );
}

/**
 * The entity an article headline is about, or null. A headline must contain
 * the entity's full name as a whole-word phrase. When several names match,
 * the article goes to the one whose name contains all the others ("Joe's
 * Pizza" over "Joe's"); otherwise it is ambiguous and attributed to nobody.
 */
export function attributeArticle(
  title: string,
  entities: Array<{ id: string; normalizedName: string }>
): string | null {
  const haystack = ` ${normalizeForMatch(title)} `;
  const matches = entities.filter((entity) =>
    haystack.includes(` ${entity.normalizedName} `)
  );
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0].id;
  const longest = matches.reduce((best, entity) =>
    entity.normalizedName.length > best.normalizedName.length ? entity : best
  );
  return matches.every(
    (entity) =>
      entity === longest ||
      ` ${longest.normalizedName} `.includes(` ${entity.normalizedName} `)
  )
    ? longest.id
    : null;
}

export function buildCombinedNewsQuery(names: string[]): string {
  const phrases = names.map((name) => `"${queryPhrase(name)}"`);
  const nameClause = phrases.length === 1 ? phrases[0] : `(${phrases.join(" OR ")})`;
  return `${nameClause} ${GDELT_TOPIC_CLAUSE}`;
}

export function gdeltQueryUrl(query: string, maxRecords: number): string {
  return `${GDELT_DOC_URL}?query=${encodeURIComponent(
    query
  )}&mode=artlist&format=json&sort=datedesc&timespan=30d&maxrecords=${maxRecords}`;
}

/**
 * One GDELT DOC API request for the user plus the top competitors, with
 * articles attributed back to entities by headline name match.
 */
export async function fetchCombinedNewsSignals(
  entities: NewsEntity[],
  options: RequestBudgetOptions = {}
): Promise<CombinedNewsResult> {
  const normalized = entities.map((entity) => ({
    id: entity.id,
    name: entity.name,
    normalizedName: normalizeForMatch(entity.name),
  }));
  const nameCounts = new Map<string, number>();
  for (const entity of normalized) {
    nameCounts.set(entity.normalizedName, (nameCounts.get(entity.normalizedName) ?? 0) + 1);
  }
  const eligible = normalized.filter(
    (entity) =>
      entity.normalizedName.replace(/ /g, "").length >= MIN_NAME_CHARS &&
      queryPhrase(entity.name).length >= MIN_NAME_CHARS &&
      nameCounts.get(entity.normalizedName) === 1
  );
  const skipped = normalized
    .filter((entity) => !eligible.includes(entity))
    .map((entity) => entity.id);
  const queried = eligible.map((entity) => entity.id);
  const queryUrl = gdeltQueryUrl(
    buildCombinedNewsQuery(eligible.map((entity) => entity.name)),
    COMBINED_MAX_RECORDS
  );
  const unavailable = (): CombinedNewsResult => ({
    status: "unavailable",
    queryUrl,
    accessedAt: new Date().toISOString(),
    queried,
    skipped,
    articlesByEntity: {},
  });
  if (eligible.length === 0 || options.signal?.aborted) {
    return eligible.length === 0
      ? { ...unavailable(), status: "complete" }
      : unavailable();
  }

  const timed = createTimedSignal(
    options.signal,
    options.budgetMs ?? DEFAULT_NEWS_TIMEOUT_MS
  );
  try {
    const response = await fetch(queryUrl, {
      signal: timed.signal,
      headers: { "User-Agent": USER_AGENT },
    });
    if (!response.ok) return unavailable();
    const articles = parseArticles(await response.text());
    if (articles === null) return unavailable();

    const articlesByEntity: Record<string, NewsSignal[]> = Object.fromEntries(
      queried.map((id) => [id, [] as NewsSignal[]])
    );
    const seenUrls = new Set<string>();
    for (const article of usableArticles(articles)) {
      if (seenUrls.has(article.url)) continue;
      const entityId = attributeArticle(article.title, eligible);
      if (!entityId) continue;
      const list = articlesByEntity[entityId];
      if (list.length >= MAX_SIGNALS_PER_ENTITY) continue;
      seenUrls.add(article.url);
      list.push(toSignal(article));
    }
    return {
      status: "complete",
      queryUrl,
      accessedAt: new Date().toISOString(),
      queried,
      skipped,
      articlesByEntity,
    };
  } catch {
    return unavailable();
  } finally {
    timed.cleanup();
  }
}

/** Single-entity lookup (kept for callers that need one name). */
export async function fetchNewsSignals(
  businessName: string,
  options: RequestBudgetOptions = {}
): Promise<NewsFetchResult> {
  const queryUrl = gdeltQueryUrl(buildCombinedNewsQuery([businessName]), 5);
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
      headers: { "User-Agent": USER_AGENT },
    });
    if (!response.ok) return unavailable();
    const articles = parseArticles(await response.text());
    if (articles === null) return unavailable();
    return {
      status: "complete",
      signals: usableArticles(articles).slice(0, 5).map(toSignal),
      queryUrl,
      accessedAt: new Date().toISOString(),
    };
  } catch {
    return unavailable();
  } finally {
    timed.cleanup();
  }
}
