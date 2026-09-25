import { CACHE_TTL, readCache, writeCache } from "./cache";
import { logger, serializeError } from "./logger";
import {
  AmbiguousMarketError,
  MarketNotFoundError,
  SourceUnavailableError,
} from "./pipeline-errors";
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
  /** Nominatim order: [south, north, west, east]. */
  boundingBox?: [number, number, number, number];
  source: "nominatim";
  accessedAt: string;
  /** The exact Nominatim request that produced this result. */
  queryUrl?: string;
  /** Nominatim addresstype of the chosen place (city, town, suburb...). */
  placeType?: string;
};

const USER_AGENT =
  process.env.APP_USER_AGENT ??
  "BenchmarkScout/0.1 (contact: github.com/loganlewisw1112-create/Benchmarket-Scout-_-scraper-tool)";

export const NOMINATIM_SEARCH_URL = "https://nominatim.openstreetmap.org/search";
const CANDIDATE_LIMIT = 10;
const PER_ATTEMPT_TIMEOUT_MS = 3_000;
// Nominatim's usage policy allows 1 request/second. A retry waits longer than
// that, and only for transient faults: 403/429 mean the policy is already
// being enforced, so retrying would make things worse.
const RETRY_BACKOFF_MS = 1_100;
const MIN_ATTEMPT_MS = 1_000;

// Places a local business can be "in". Counties, states and countries are
// excluded: their centroid can sit 30+ km from the town the user meant
// ("Alameda, CA" used to resolve to Alameda County's centroid near Sunol).
const SETTLEMENT_TYPES = new Set([
  "city",
  "town",
  "village",
  "hamlet",
  "municipality",
  "borough",
  "suburb",
  "city_district",
  "district",
  "quarter",
  "neighbourhood",
  "locality",
  "postcode",
]);

// Relative importance above which a second place in a different region is a
// genuine rival reading of the input rather than a long-tail homonym.
const AMBIGUITY_IMPORTANCE_RATIO = 0.85;

const REGION_ALIASES: Record<string, string> = {
  uk: "gb",
  "united kingdom": "gb",
  england: "gb",
  scotland: "gb",
  wales: "gb",
  usa: "us",
  "united states": "us",
  "united states of america": "us",
};

type NominatimRecord = {
  display_name?: string;
  lat?: string;
  lon?: string;
  boundingbox?: string[];
  addresstype?: string;
  importance?: number;
  address?: Record<string, string | undefined>;
};

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

function normalizeRegion(value: string | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The region part of "City, ST" / "City, Country" (text after the last comma). */
function regionOf(market: string): string | null {
  const parts = market.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const region = normalizeRegion(parts[parts.length - 1]);
  return region || null;
}

function matchesRegion(record: NominatimRecord, region: string): boolean {
  const address = record.address ?? {};
  const wanted = REGION_ALIASES[region] ?? region;
  const iso = address["ISO3166-2-lvl4"] ?? address["ISO3166-2-lvl6"];
  const values = [
    address.state,
    address.province,
    address.region,
    address.state_district,
    address.county,
    address.country,
    address.country_code,
    iso,
    iso?.split("-")[1],
  ].map(normalizeRegion);
  return values.some(
    (value) => value && (value === wanted || value === region)
  );
}

function areaKey(record: NominatimRecord): string {
  const address = record.address ?? {};
  return [
    address.country_code ?? "",
    address.state ?? address.province ?? address.region ?? "",
  ]
    .join("|")
    .toLowerCase();
}

/**
 * Choose the settlement the user meant from Nominatim's ranked candidates.
 * Throws MarketNotFoundError when only admin areas (county/state/country) or
 * non-place features matched, and AmbiguousMarketError when two comparably
 * important settlements in different regions both fit the input.
 */
export function chooseSettlement(
  market: string,
  records: NominatimRecord[]
): NominatimRecord {
  const settlements = records.filter(
    (record) =>
      typeof record.addresstype === "string" &&
      SETTLEMENT_TYPES.has(record.addresstype)
  );
  if (settlements.length === 0) {
    throw new MarketNotFoundError(
      market,
      records.length > 0
        ? `"${market}" matched a county, state or other area, not a city or town. Enter the city the business is in, for example "Alameda, CA".`
        : undefined
    );
  }

  const region = regionOf(market);
  const inRegion = region
    ? settlements.filter((record) => matchesRegion(record, region))
    : [];
  const pool = (inRegion.length > 0 ? inRegion : settlements)
    .slice()
    .sort((left, right) => (right.importance ?? 0) - (left.importance ?? 0));
  const [top] = pool;
  const topImportance = top.importance ?? 0;
  const rivals = pool.filter(
    (record) =>
      record !== top &&
      areaKey(record) !== areaKey(top) &&
      topImportance > 0 &&
      (record.importance ?? 0) >= topImportance * AMBIGUITY_IMPORTANCE_RATIO
  );
  if (rivals.length > 0) {
    throw new AmbiguousMarketError(
      market,
      [top, ...rivals]
        .map((record) => record.display_name)
        .filter((label): label is string => Boolean(label))
    );
  }
  return top;
}

export function nominatimSearchUrl(market: string): string {
  return `${NOMINATIM_SEARCH_URL}?q=${encodeURIComponent(
    market
  )}&format=jsonv2&addressdetails=1&limit=${CANDIDATE_LIMIT}`;
}

class NonRetryableGeocodeError extends Error {}

export async function geocodeMarket(
  market: string,
  options: RequestBudgetOptions = {}
): Promise<GeocodeResult> {
  const deadlineAt = Date.now() + (options.budgetMs ?? 17_000);
  const cacheKey = `v3:nominatim:${market.toLowerCase().trim()}`;
  const cached = await readCache<unknown>("geocode", cacheKey, CACHE_TTL.geocode);
  if (isValidResult(cached)) return cached;

  const url = nominatimSearchUrl(market);
  const maxAttempts = 2;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const remaining = remainingBudgetMs(deadlineAt);
    if (options.signal?.aborted || remaining < MIN_ATTEMPT_MS) {
      lastError =
        options.signal?.reason ?? lastError ?? new Error("Geocode time budget exhausted");
      break;
    }
    const timed = createTimedSignal(
      options.signal,
      Math.min(PER_ATTEMPT_TIMEOUT_MS, remaining)
    );
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        signal: timed.signal,
      });
      if (!response.ok) {
        const message = `Nominatim returned HTTP ${response.status}`;
        if (response.status < 500) throw new NonRetryableGeocodeError(message);
        throw new Error(message);
      }

      const data = (await response.json()) as NominatimRecord[];
      if (!Array.isArray(data)) throw new Error("Nominatim returned invalid JSON");
      if (data.length === 0) throw new MarketNotFoundError(market);

      const chosen = chooseSettlement(market, data);
      const lat = Number(chosen.lat);
      const lon = Number(chosen.lon);
      if (!chosen.display_name || !Number.isFinite(lat) || !Number.isFinite(lon)) {
        throw new Error("Nominatim returned an invalid location record");
      }
      const bbox = chosen.boundingbox?.map(Number);
      const result: GeocodeResult = {
        label: chosen.display_name,
        lat,
        lon,
        boundingBox:
          bbox?.length === 4 && bbox.every(Number.isFinite)
            ? (bbox as [number, number, number, number])
            : undefined,
        source: "nominatim",
        accessedAt: new Date().toISOString(),
        queryUrl: url,
        placeType: chosen.addresstype,
      };
      await writeCache("geocode", cacheKey, result);
      return result;
    } catch (error) {
      if (
        error instanceof MarketNotFoundError ||
        error instanceof AmbiguousMarketError
      ) {
        throw error;
      }
      lastError = error;
      if (error instanceof NonRetryableGeocodeError) break;
      if (
        attempt < maxAttempts &&
        !options.signal?.aborted &&
        remainingBudgetMs(deadlineAt) >= RETRY_BACKOFF_MS + MIN_ATTEMPT_MS
      ) {
        await abortableDelay(RETRY_BACKOFF_MS, options.signal);
      } else {
        break;
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
