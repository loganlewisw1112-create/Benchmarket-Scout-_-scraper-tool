import { CACHE_TTL, readCache, writeCache } from "./cache";
import { logger, serializeError } from "./logger";
import { MarketNotFoundError, SourceUnavailableError } from "./pipeline-errors";
import {
  abortableDelay,
  createTimedSignal,
  remainingBudgetMs,
  type RequestBudgetOptions,
} from "./time-budget";

export type GeocodeResult = {
  label: string;
  lat: number;
  lon: number;
  boundingBox?: [number, number, number, number];
  source: "nominatim";
  accessedAt: string;
};

const USER_AGENT =
  process.env.APP_USER_AGENT ??
  "BenchmarkScout/0.1 (contact: github.com/loganlewisw1112-create/Benchmarket-Scout-_-scraper-tool)";

function isValidResult(value: unknown): value is GeocodeResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<GeocodeResult>;
  return (
    result.source === "nominatim" &&
    typeof result.label === "string" &&
    Number.isFinite(result.lat) &&
    Number.isFinite(result.lon) &&
    typeof result.accessedAt === "string" &&
    !Number.isNaN(Date.parse(result.accessedAt))
  );
}

export async function geocodeMarket(
  market: string,
  options: RequestBudgetOptions = {}
): Promise<GeocodeResult> {
  const deadlineAt = Date.now() + (options.budgetMs ?? 17_000);
  const cacheKey = `v2:nominatim:${market.toLowerCase().trim()}`;
  const cached = await readCache<unknown>("geocode", cacheKey, CACHE_TTL.geocode);
  if (isValidResult(cached)) return cached;

  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(
    market
  )}&format=jsonv2&limit=1&addressdetails=1`;
  const maxAttempts = 2;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const remaining = remainingBudgetMs(deadlineAt);
    if (options.signal?.aborted || remaining === 0) {
      lastError = options.signal?.reason ?? new Error("Geocode time budget exhausted");
      break;
    }
    const timed = createTimedSignal(options.signal, Math.min(2_200, remaining));
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        signal: timed.signal,
      });
      if (!response.ok) {
        throw new Error(`Nominatim returned HTTP ${response.status}`);
      }

      const data = (await response.json()) as Array<{
        display_name?: string;
        lat?: string;
        lon?: string;
        boundingbox?: string[];
      }>;
      if (!Array.isArray(data)) throw new Error("Nominatim returned invalid JSON");
      if (data.length === 0) throw new MarketNotFoundError(market);

      const first = data[0];
      const lat = Number(first.lat);
      const lon = Number(first.lon);
      if (!first.display_name || !Number.isFinite(lat) || !Number.isFinite(lon)) {
        throw new Error("Nominatim returned an invalid location record");
      }
      const bbox = first.boundingbox?.map(Number);
      const result: GeocodeResult = {
        label: first.display_name,
        lat,
        lon,
        boundingBox:
          bbox?.length === 4 && bbox.every(Number.isFinite)
            ? (bbox as [number, number, number, number])
            : undefined,
        source: "nominatim",
        accessedAt: new Date().toISOString(),
      };
      await writeCache("geocode", cacheKey, result);
      return result;
    } catch (error) {
      if (error instanceof MarketNotFoundError) throw error;
      lastError = error;
      if (attempt < maxAttempts && !options.signal?.aborted) {
        await abortableDelay(
          Math.min(300, remainingBudgetMs(deadlineAt)),
          options.signal
        );
      }
    } finally {
      timed.cleanup();
    }
  }

  logger.warn("Nominatim geocoding unavailable", serializeError(lastError));
  throw new SourceUnavailableError(
    "nominatim",
    "Market lookup is temporarily unavailable.",
    lastError
  );
}
