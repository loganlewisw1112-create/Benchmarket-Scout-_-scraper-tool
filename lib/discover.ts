import {
  DEFAULT_DISCOVERY_RADIUS_METERS,
  queryOverpassDetailed,
  resolveIndustry,
  type IndustryResolution,
  type OverpassCacheUse,
  type OverpassElement,
} from "./overpass";
import { remainingBudgetMs } from "./time-budget";
import { normalizeHttpUrl } from "./url-safety";

export type DiscoveredCandidate = {
  id: string;
  osmElementUrl: string;
  name: string;
  website?: string;
  phone?: string;
  address?: string;
  lat?: number;
  lon?: number;
  source: "overpass";
  priorityScore: number;
  /** Great-circle distance from the market center, set during discovery. */
  distanceKm?: number;
  /** OSM brand / brand:wikidata tag, or a website shared by 2+ locations. */
  isChain?: boolean;
  brand?: string;
  /** Raw OSM brand evidence, used to flag chains. */
  hasBrandTag?: boolean;
  /** The element's OSM tags, for category-match scoring. */
  osmTags?: Record<string, string>;
};

export type DiscoveryResult = {
  /** Named competitors, nearest to the market center first. */
  candidates: DiscoveredCandidate[];
  discoverySource: "overpass";
  status: "complete" | "limited";
  queryPerformed: boolean;
  endpoint?: string;
  accessedAt: string;
  /** Exact Overpass QL of the query whose results were used. */
  query?: string;
  /** Search radius actually used for the returned candidates. */
  radiusKm: number;
  /** True when even the narrowest query hit the Overpass element cap. */
  truncated: boolean;
  resolution: IndustryResolution;
  /** The user's own OSM listing, when self-exclusion found one. */
  userMatch?: DiscoveredCandidate;
  /**
   * Set when the candidates came from the discovery cache rather than a live
   * query; `accessedAt` is then the original retrieval time (lib/overpass.ts).
   */
  cache?: OverpassCacheUse;
};

const EARTH_RADIUS_KM = 6371.0088;
export const MIN_DISCOVERY_RADIUS_KM = 2;
export const MAX_DISCOVERY_RADIUS_KM = 12;
// Two OSM records with the same name are one business only when they are
// this close (a POI node inside its building way) or share an address.
const SAME_NAME_MAX_METERS = 150;
// Same non-shared website or phone: still require the records to be close,
// otherwise every branch of a chain would collapse into one.
const SAME_CONTACT_MAX_METERS = 250;
// A truncated response is re-queried at a smaller radius while this much of
// the discovery budget remains.
const NARROWING_MIN_BUDGET_MS = 8_000;
const MAX_NARROWINGS = 2;

// Multi-tenant hosts: a page on these identifies the tenant by its path, so
// the bare hostname is never evidence that two listings are one business.
const SHARED_HOSTS = [
  "facebook.com",
  "fb.com",
  "fb.me",
  "instagram.com",
  "twitter.com",
  "x.com",
  "tiktok.com",
  "linkedin.com",
  "youtube.com",
  "yelp.com",
  "google.com",
  "goo.gl",
  "g.page",
  "sites.google.com",
  "business.site",
  "wixsite.com",
  "wix.com",
  "square.site",
  "squareup.com",
  "squarespace.com",
  "linktr.ee",
  "linktree.com",
  "wordpress.com",
  "blogspot.com",
  "weebly.com",
  "godaddysites.com",
  "carrd.co",
  "myshopify.com",
  "github.io",
  "netlify.app",
  "vercel.app",
  "nextdoor.com",
  "yellowpages.com",
  "tripadvisor.com",
  "doordash.com",
  "ubereats.com",
  "grubhub.com",
  "toasttab.com",
  "opentable.com",
  "resy.com",
  "vagaro.com",
  "booksy.com",
  "mindbodyonline.com",
  "schedulicity.com",
  "setmore.com",
  "ueniweb.com",
  "site123.me",
  "jimdosite.com",
  "webnode.com",
] as const;

// Second-level public suffixes under which the registrable domain has three
// labels (example.co.uk). Deliberately small: it only has to keep distinct
// businesses from sharing a "root".
const TWO_LABEL_SUFFIXES = new Set([
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.uk",
  "com.au",
  "net.au",
  "org.au",
  "co.nz",
  "co.za",
  "com.br",
  "co.jp",
  "co.in",
  "com.mx",
]);

// Generic second-level labels that ccTLD registries sell names under
// (example.com.sg, example.co.il, example.ne.jp). Under a two-letter ccTLD
// these mark a public suffix even when the pair is not listed above, so
// unrelated businesses on com.sg never share the "root" com.sg.
const GENERIC_SECOND_LEVEL_LABELS = new Set([
  "com",
  "co",
  "org",
  "net",
  "gov",
  "edu",
  "ac",
  "or",
  "ne",
  "go",
  "gob",
  "gv",
  "mil",
  "nom",
  "ltd",
  "plc",
  "sch",
  "biz",
  "info",
]);

export function haversineKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

function roundKm(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Search radius sized to the geocoded place: the larger half-extent of its
 * bounding box (Nominatim order [south, north, west, east]), clamped so a
 * village still gets a meaningful circle and a sprawling city (or one whose
 * bbox includes offshore islands) does not reach the next metro area.
 */
export function discoveryRadiusKm(
  bbox?: readonly [number, number, number, number]
): number {
  if (!bbox || !bbox.every(Number.isFinite)) {
    return DEFAULT_DISCOVERY_RADIUS_METERS / 1000;
  }
  const [south, north, west, east] = bbox;
  const midLat = (south + north) / 2;
  const midLon = (west + east) / 2;
  const halfHeight = haversineKm(south, midLon, north, midLon) / 2;
  const halfWidth = haversineKm(midLat, west, midLat, east) / 2;
  const radius = Math.max(halfHeight, halfWidth);
  return roundKm(
    Math.min(MAX_DISCOVERY_RADIUS_KM, Math.max(MIN_DISCOVERY_RADIUS_KM, radius))
  );
}

/**
 * Name normalization for matching. Apostrophes and quotes (straight or
 * curly) are dropped rather than turned into spaces, so "Moe's", "Moe’s" and
 * a sanitized "Moes" all compare equal; corporate suffixes are ignored.
 */
export function normalizeBusinessName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’‘`´"“”]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(llc|inc|ltd|corp|co|the)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The part of an OSM name before a branch suffix ("Joe's Pizza - Park St"). */
function primaryNameSegment(name: string): string {
  return normalizeBusinessName(name.split(/\s[-–—|@]\s|\s*\(|,/)[0] ?? name);
}

function parseUrl(url?: string): URL | undefined {
  if (!url) return undefined;
  try {
    return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
  } catch {
    return undefined;
  }
}

function hostOf(url?: string): string | undefined {
  return parseUrl(url)?.hostname.replace(/^www\./, "").replace(/\.$/, "").toLowerCase();
}

export function isSharedHost(host: string): boolean {
  return SHARED_HOSTS.some(
    (shared) => host === shared || host.endsWith(`.${shared}`)
  );
}

/**
 * Registrable domain approximation: "locations.greatclips.com" ->
 * "greatclips.com", "shop.bakery.com.sg" -> "bakery.com.sg".
 */
export function domainRoot(host: string): string {
  const labels = host.split(".");
  if (labels.length <= 2) return host;
  const lastTwo = labels.slice(-2).join(".");
  const [secondLevel, topLevel] = labels.slice(-2);
  const twoLabelSuffix =
    TWO_LABEL_SUFFIXES.has(lastTwo) ||
    (/^[a-z]{2}$/.test(topLevel) && GENERIC_SECOND_LEVEL_LABELS.has(secondLevel));
  return twoLabelSuffix ? labels.slice(-3).join(".") : lastTwo;
}

/**
 * A website identity usable for matching, or undefined. On shared hosts the
 * tenant path is part of the identity (facebook.com/alsbarbershop), and a
 * bare shared host (facebook.com/) identifies nobody.
 */
export function siteIdentity(url?: string): string | undefined {
  return siteIdentityOf(url, "registrable");
}

/**
 * Like siteIdentity, but an own-domain site is identified by its exact host
 * (www-insensitive) rather than its registrable domain. Used to recognise the
 * user's own listing, so a mistaken registrable-domain guess can never remove
 * a competitor or adopt its OSM record as the user's.
 */
export function exactSiteIdentity(url?: string): string | undefined {
  return siteIdentityOf(url, "host");
}

function siteIdentityOf(
  url: string | undefined,
  ownDomain: "registrable" | "host"
): string | undefined {
  const parsed = parseUrl(url);
  const rawHost = hostOf(url);
  if (!parsed || !rawHost) return undefined;
  if (isSharedHost(rawHost)) {
    const host = rawHost.replace(/^m\./, "");
    // Tenant subdomain (alsbarber.wixsite.com): the host is the identity.
    if (!(SHARED_HOSTS as readonly string[]).includes(host)) return `site:${host}`;
    // Tenant path (facebook.com/alsbarbershop, sites.google.com/view/x).
    const path = parsed.pathname.replace(/\/+$/, "").toLowerCase();
    if (!path) return undefined;
    const profileId = parsed.searchParams.get("id");
    return `site:${host}${path}${profileId ? `?id=${profileId}` : ""}`;
  }
  return `site:${ownDomain === "host" ? rawHost : domainRoot(rawHost)}`;
}

function buildAddress(tags: Record<string, string>): string | undefined {
  const parts = [
    tags["addr:housenumber"],
    tags["addr:street"],
    tags["addr:city"],
    tags["addr:state"],
    tags["addr:postcode"],
  ].filter(Boolean);
  return parts.length ? parts.join(" ") : undefined;
}

function categoryRelevance(
  tags: Record<string, string>,
  businessType: string
): number {
  const type = businessType.toLowerCase();
  const values = Object.values(tags).join(" ").toLowerCase();
  return values.includes(type) ? 10 : 0;
}

export function elementToCandidate(
  element: OverpassElement,
  businessType: string
): DiscoveredCandidate | null {
  const tags = element.tags ?? {};
  const name = tags.name?.trim();
  if (!name) return null;

  const rawWebsite = tags.website ?? tags["contact:website"];
  let website: string | undefined;
  if (rawWebsite) {
    try {
      website = normalizeHttpUrl(rawWebsite);
    } catch {
      website = undefined;
    }
  }
  const phone = tags.phone ?? tags["contact:phone"];
  const address = buildAddress(tags);
  const lat = element.lat ?? element.center?.lat;
  const lon = element.lon ?? element.center?.lon;
  let priorityScore = 0;
  if (website) priorityScore += 30;
  priorityScore += categoryRelevance(tags, businessType) * 2;
  if (phone || tags["contact:email"] || tags.email) priorityScore += 20;
  if (address || (lat !== undefined && lon !== undefined)) priorityScore += 15;
  if (name.toLowerCase().includes(businessType.toLowerCase())) priorityScore += 10;
  priorityScore += Math.min(5, Object.keys(tags).length / 2);
  const brand = tags.brand?.trim();
  const hasBrandTag = Boolean(brand || tags["brand:wikidata"]?.trim());

  return {
    id: `osm-${element.type}-${element.id}`,
    osmElementUrl: `https://www.openstreetmap.org/${element.type}/${element.id}`,
    name,
    website,
    phone,
    address,
    lat,
    lon,
    source: "overpass",
    priorityScore,
    osmTags: tags,
    ...(hasBrandTag ? { hasBrandTag: true, brand: brand || name } : {}),
  };
}

function metersBetween(
  left: DiscoveredCandidate,
  right: DiscoveredCandidate
): number | undefined {
  if (
    left.lat === undefined ||
    left.lon === undefined ||
    right.lat === undefined ||
    right.lon === undefined
  ) {
    return undefined;
  }
  return haversineKm(left.lat, left.lon, right.lat, right.lon) * 1000;
}

function phoneDigits(phone?: string): string | undefined {
  const digits = phone?.replace(/\D/g, "");
  return digits && digits.length >= 7 ? digits.slice(-10) : undefined;
}

/**
 * True when two OSM records describe one physical business (typically a POI
 * node plus its building way). A shared name only counts with a matching
 * address or when the records are within ~150 m; a shared own-domain website
 * or phone number only within ~250 m, so distinct branches stay distinct.
 */
function sameBusiness(left: DiscoveredCandidate, right: DiscoveredCandidate): boolean {
  const meters = metersBetween(left, right);
  const within = (limit: number) => meters !== undefined && meters <= limit;

  const leftName = normalizeBusinessName(left.name);
  if (leftName && leftName === normalizeBusinessName(right.name)) {
    if (
      left.address &&
      right.address &&
      normalizeBusinessName(left.address) === normalizeBusinessName(right.address)
    ) {
      return true;
    }
    if (within(SAME_NAME_MAX_METERS)) return true;
  }

  const leftSite = siteIdentity(left.website);
  if (leftSite && leftSite === siteIdentity(right.website)) {
    if (within(SAME_CONTACT_MAX_METERS)) return true;
  }
  const leftPhone = phoneDigits(left.phone);
  if (leftPhone && leftPhone === phoneDigits(right.phone)) {
    if (within(SAME_CONTACT_MAX_METERS)) return true;
  }
  return false;
}

export function dedupeCandidates(
  candidates: DiscoveredCandidate[]
): DiscoveredCandidate[] {
  const parent = candidates.map((_, index) => index);
  const find = (index: number): number => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
  };
  for (let left = 0; left < candidates.length; left++) {
    for (let right = left + 1; right < candidates.length; right++) {
      if (sameBusiness(candidates[left], candidates[right])) union(left, right);
    }
  }

  const bestByRoot = new Map<number, DiscoveredCandidate>();
  candidates.forEach((candidate, index) => {
    const root = find(index);
    const current = bestByRoot.get(root);
    if (
      !current ||
      candidate.priorityScore > current.priorityScore ||
      (candidate.priorityScore === current.priorityScore &&
        candidate.id.localeCompare(current.id) < 0)
    ) {
      bestByRoot.set(root, candidate);
    }
  });

  return [...bestByRoot.values()].sort(
    (left, right) =>
      right.priorityScore - left.priorityScore || left.id.localeCompare(right.id)
  );
}

/**
 * Contract 6: a competitor is a chain when its OSM element carries brand /
 * brand:wikidata, or when its own-domain website root is listed by two or
 * more distinct discovered businesses (a corporate site, not a local one).
 */
export function flagChains(candidates: DiscoveredCandidate[]): DiscoveredCandidate[] {
  const rootCounts = new Map<string, number>();
  const rootOf = (candidate: DiscoveredCandidate): string | undefined => {
    const host = hostOf(candidate.website);
    return host && !isSharedHost(host) ? domainRoot(host) : undefined;
  };
  for (const candidate of candidates) {
    const root = rootOf(candidate);
    if (root) rootCounts.set(root, (rootCounts.get(root) ?? 0) + 1);
  }
  return candidates.map((candidate) => {
    const root = rootOf(candidate);
    const sharedSite = root !== undefined && (rootCounts.get(root) ?? 0) >= 2;
    if (!candidate.hasBrandTag && !sharedSite) return candidate;
    return {
      ...candidate,
      isChain: true,
      brand: candidate.brand ?? candidate.name,
    };
  });
}

function matchesUser(
  candidate: DiscoveredCandidate,
  userName: string,
  userSite: string | undefined
): "site" | "name" | null {
  if (userSite && exactSiteIdentity(candidate.website) === userSite) return "site";
  if (!userName) return null;
  const candidateName = normalizeBusinessName(candidate.name);
  if (
    candidateName === userName ||
    primaryNameSegment(candidate.name) === userName
  ) {
    return "name";
  }
  return null;
}

/**
 * Split out the user's own listing(s). Matching drops apostrophes and quote
 * styles, ignores branch suffixes, and compares websites by exact host
 * (www-insensitive), or by host plus tenant path on shared hosts, so a
 * Facebook-page user never removes every Facebook-hosted competitor.
 */
export function splitUserBusiness(
  candidates: DiscoveredCandidate[],
  userBusinessName: string,
  userDomain?: string
): { competitors: DiscoveredCandidate[]; userMatch?: DiscoveredCandidate } {
  const userName = primaryNameSegment(userBusinessName);
  const userSite = exactSiteIdentity(userDomain);
  const competitors: DiscoveredCandidate[] = [];
  const matches: Array<{ candidate: DiscoveredCandidate; by: "site" | "name" }> = [];
  for (const candidate of candidates) {
    const by = matchesUser(candidate, userName, userSite);
    if (by) matches.push({ candidate, by });
    else competitors.push(candidate);
  }
  const userMatch = matches
    .slice()
    .sort(
      (left, right) =>
        (left.by === "site" ? 0 : 1) - (right.by === "site" ? 0 : 1) ||
        (left.candidate.distanceKm ?? Infinity) - (right.candidate.distanceKm ?? Infinity)
    )[0]?.candidate;
  return { competitors, userMatch };
}

export function removeUserBusiness(
  candidates: DiscoveredCandidate[],
  userBusinessName: string,
  userDomain?: string
): DiscoveredCandidate[] {
  return splitUserBusiness(candidates, userBusinessName, userDomain).competitors;
}

function byDistance(left: DiscoveredCandidate, right: DiscoveredCandidate): number {
  return (
    (left.distanceKm ?? Infinity) - (right.distanceKm ?? Infinity) ||
    left.id.localeCompare(right.id)
  );
}

export async function discoverCompetitors(args: {
  businessType: string;
  userBusinessName: string;
  userDomain?: string;
  lat: number;
  lon: number;
  /** Geocoded bounding box, used to size the search radius. */
  bbox?: readonly [number, number, number, number];
  signal?: AbortSignal;
  budgetMs?: number;
}): Promise<DiscoveryResult> {
  const deadlineAt = Date.now() + (args.budgetMs ?? 24_000);
  const resolution = resolveIndustry(args.businessType);
  let radiusKm = discoveryRadiusKm(args.bbox);
  if (resolution.tags.length === 0) {
    return {
      candidates: [],
      discoverySource: "overpass",
      status: "limited",
      queryPerformed: false,
      accessedAt: new Date().toISOString(),
      radiusKm,
      truncated: false,
      resolution,
    };
  }

  let query = await queryOverpassDetailed(
    args.businessType,
    args.lat,
    args.lon,
    radiusKm * 1000,
    { signal: args.signal, budgetMs: remainingBudgetMs(deadlineAt) }
  );
  // Overpass truncates in element-id order, not by distance, so a capped
  // response is not "the nearest N". Narrow the circle while budget allows.
  for (
    let narrowing = 0;
    query.truncated &&
    narrowing < MAX_NARROWINGS &&
    radiusKm > MIN_DISCOVERY_RADIUS_KM &&
    remainingBudgetMs(deadlineAt) >= NARROWING_MIN_BUDGET_MS &&
    !args.signal?.aborted;
    narrowing++
  ) {
    const narrowerKm = roundKm(Math.max(MIN_DISCOVERY_RADIUS_KM, radiusKm / 2));
    try {
      const narrower = await queryOverpassDetailed(
        args.businessType,
        args.lat,
        args.lon,
        narrowerKm * 1000,
        { signal: args.signal, budgetMs: remainingBudgetMs(deadlineAt) }
      );
      query = narrower;
      radiusKm = narrowerKm;
    } catch {
      // Keep the wider (truncated) result rather than failing discovery.
      break;
    }
  }

  const located = query.elements
    .map((element) => elementToCandidate(element, args.businessType))
    .filter(
      (candidate): candidate is DiscoveredCandidate =>
        candidate !== null &&
        candidate.lat !== undefined &&
        candidate.lon !== undefined
    )
    .map((candidate) => ({
      ...candidate,
      distanceKm: roundKm(
        haversineKm(args.lat, args.lon, candidate.lat!, candidate.lon!)
      ),
    }));
  const { competitors, userMatch } = splitUserBusiness(
    flagChains(dedupeCandidates(located)),
    args.userBusinessName,
    args.userDomain
  );
  return {
    candidates: competitors.sort(byDistance),
    discoverySource: "overpass",
    status: query.truncated ? "limited" : "complete",
    queryPerformed: true,
    endpoint: query.endpoint,
    accessedAt: query.accessedAt,
    query: query.query,
    radiusKm,
    truncated: query.truncated,
    resolution,
    ...(userMatch ? { userMatch } : {}),
    ...(query.cache ? { cache: query.cache } : {}),
  };
}
