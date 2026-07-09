export type OsmTagPair = [string, string];

export const OSM_CATEGORY_MAP: Record<string, OsmTagPair[]> = {
  landscaping: [
    ["craft", "gardener"],
    ["office", "landscape_architect"],
    ["shop", "garden_centre"],
  ],
  landscaper: [
    ["craft", "gardener"],
    ["office", "landscape_architect"],
    ["shop", "garden_centre"],
  ],
  plumber: [["craft", "plumber"]],
  plumbing: [["craft", "plumber"]],
  dentist: [["amenity", "dentist"]],
  dental: [["amenity", "dentist"]],
  restaurant: [["amenity", "restaurant"]],
  cafe: [["amenity", "cafe"]],
  gym: [["leisure", "fitness_centre"]],
  fitness: [["leisure", "fitness_centre"]],
  salon: [
    ["shop", "hairdresser"],
    ["shop", "beauty"],
  ],
  barber: [["shop", "hairdresser"]],
  "auto repair": [["shop", "car_repair"]],
  mechanic: [["shop", "car_repair"]],
  lawyer: [["office", "lawyer"]],
  accountant: [["office", "accountant"]],
  cleaning: [["craft", "cleaner"]],
  electrician: [["craft", "electrician"]],
  contractor: [["craft", "builder"]],
  roofing: [["craft", "roofer"]],
  realestate: [["office", "estate_agent"]],
  "real estate": [["office", "estate_agent"]],
};

const DEFAULT_TAGS: OsmTagPair[] = [
  ["shop", "yes"],
  ["office", "yes"],
];

export function resolveOsmTags(businessType: string): OsmTagPair[] {
  const key = businessType.trim().toLowerCase();
  return OSM_CATEGORY_MAP[key] ?? DEFAULT_TAGS;
}

export type OverpassElement = {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
};

const USER_AGENT =
  process.env.APP_USER_AGENT ??
  "BenchmarkScout/0.1 (contact: github.com/loganlewisw1112-create/Benchmarket-Scout-_-scraper-tool)";

// The public Overpass API is known to be intermittently flaky (occasional
// 504s under load even when the service is generally up). We retry the
// primary endpoint a couple of times before spreading attempts across
// alternate public mirrors, rather than giving up on the first failure.
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.ru/api/interpreter",
];

const ATTEMPTS_PER_ENDPOINT = 2;
const PER_REQUEST_TIMEOUT_MS = 15000;
const RETRY_BACKOFF_MS = 800;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchOverpassOnce(
  endpoint: string,
  query: string
): Promise<OverpassElement[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PER_REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT,
        Accept: "application/json",
      },
      body: `data=${encodeURIComponent(query)}`,
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`Overpass (${endpoint}) returned HTTP ${res.status}`);
    }

    const text = await res.text();
    let data: { elements?: OverpassElement[] };
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Overpass (${endpoint}) returned a non-JSON response`);
    }

    return data.elements ?? [];
  } finally {
    clearTimeout(timeout);
  }
}

export async function queryOverpass(
  businessType: string,
  lat: number,
  lon: number,
  radiusMeters = 12000
): Promise<OverpassElement[]> {
  const tagPairs = resolveOsmTags(businessType);

  const clauses = tagPairs
    .map(
      ([key, value]) =>
        `nwr["${key}"="${value}"](around:${radiusMeters},${lat},${lon});`
    )
    .join("\n  ");

  const query = `[out:json][timeout:25];
(
  ${clauses}
);
out center tags 30;`;

  let lastError: unknown;

  for (const endpoint of OVERPASS_ENDPOINTS) {
    for (let attempt = 1; attempt <= ATTEMPTS_PER_ENDPOINT; attempt++) {
      try {
        return await fetchOverpassOnce(endpoint, query);
      } catch (err) {
        lastError = err;
        const isLastAttemptOnEndpoint = attempt === ATTEMPTS_PER_ENDPOINT;
        if (!isLastAttemptOnEndpoint) {
          await sleep(RETRY_BACKOFF_MS * attempt);
        }
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Overpass discovery failed across all endpoints and retries");
}
