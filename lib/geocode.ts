import { CACHE_TTL, readCache, writeCache } from "./cache";
import { logger, serializeError } from "./logger";
import { MOCK_MARKET_COORDINATES } from "./mock-data";

export type GeocodeResult = {
  label: string;
  lat: number;
  lon: number;
  boundingBox?: [number, number, number, number];
  source: "nominatim" | "mock";
};

const USER_AGENT =
  process.env.APP_USER_AGENT ??
  "BenchmarkScout/0.1 (contact: github.com/loganlewisw1112-create/Benchmarket-Scout-_-scraper-tool)";

export async function geocodeMarket(market: string): Promise<GeocodeResult> {
  const cacheKey = `nominatim:${market.toLowerCase().trim()}`;
  const cached = await readCache<GeocodeResult>(
    "geocode",
    cacheKey,
    CACHE_TTL.geocode
  );
  if (cached) return cached;

  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(
    market
  )}&format=jsonv2&limit=1&addressdetails=1`;

  const MAX_ATTEMPTS = 2;
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    try {
      const res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        signal: controller.signal,
      });

      if (!res.ok) throw new Error(`Nominatim returned ${res.status}`);

      const data = (await res.json()) as Array<{
        display_name: string;
        lat: string;
        lon: string;
        boundingbox?: string[];
      }>;

      if (!data.length) throw new Error("No geocode results");

      const first = data[0];
      const result: GeocodeResult = {
        label: first.display_name,
        lat: parseFloat(first.lat),
        lon: parseFloat(first.lon),
        boundingBox: first.boundingbox
          ? ([
              parseFloat(first.boundingbox[0]),
              parseFloat(first.boundingbox[1]),
              parseFloat(first.boundingbox[2]),
              parseFloat(first.boundingbox[3]),
            ] as [number, number, number, number])
          : undefined,
        source: "nominatim",
      };

      await writeCache("geocode", cacheKey, result);
      return result;
    } catch (err) {
      lastError = err;
      if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, 700));
    } finally {
      clearTimeout(timeout);
    }
  }

  logger.warn("Nominatim geocoding failed, falling back to approximate coordinates", {
    ...serializeError(lastError),
  });

  return {
    label: `${market} (approximate, fallback data)`,
    lat: MOCK_MARKET_COORDINATES.lat,
    lon: MOCK_MARKET_COORDINATES.lon,
    source: "mock",
  };
}
