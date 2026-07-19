import {
  queryOverpassDetailed,
  resolveOsmTags,
  type OverpassElement,
} from "./overpass";
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
};

export type DiscoveryResult = {
  candidates: DiscoveredCandidate[];
  discoverySource: "overpass";
  status: "complete" | "limited";
  queryPerformed: boolean;
  endpoint?: string;
  accessedAt: string;
};

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function extractDomain(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    const normalized = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    return new URL(normalized).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return undefined;
  }
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
  };
}

function identityKeys(candidate: DiscoveredCandidate): string[] {
  return [
    `name:${normalizeName(candidate.name)}|${
      candidate.address ? normalizeName(candidate.address) : ""
    }`,
    candidate.website ? `domain:${extractDomain(candidate.website)}` : "",
    candidate.phone ? `phone:${candidate.phone.replace(/\D/g, "")}` : "",
  ].filter((key) => key && !key.endsWith(":"));
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
  const ownerByKey = new Map<string, number>();
  candidates.forEach((candidate, index) => {
    for (const key of identityKeys(candidate)) {
      const owner = ownerByKey.get(key);
      if (owner === undefined) ownerByKey.set(key, index);
      else union(index, owner);
    }
  });

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

export function removeUserBusiness(
  candidates: DiscoveredCandidate[],
  userBusinessName: string,
  userDomain?: string
): DiscoveredCandidate[] {
  const normalizedUserName = normalizeName(userBusinessName);
  return candidates.filter((candidate) => {
    const sameName = normalizeName(candidate.name) === normalizedUserName;
    const sameDomain =
      userDomain && extractDomain(candidate.website) === extractDomain(userDomain);
    return !sameName && !sameDomain;
  });
}

export async function discoverCompetitors(args: {
  businessType: string;
  userBusinessName: string;
  userDomain?: string;
  lat: number;
  lon: number;
  signal?: AbortSignal;
  budgetMs?: number;
}): Promise<DiscoveryResult> {
  if (resolveOsmTags(args.businessType).length === 0) {
    return {
      candidates: [],
      discoverySource: "overpass",
      status: "limited",
      queryPerformed: false,
      accessedAt: new Date().toISOString(),
    };
  }
  const query = await queryOverpassDetailed(
    args.businessType,
    args.lat,
    args.lon,
    12_000,
    { signal: args.signal, budgetMs: args.budgetMs }
  );
  const candidates = removeUserBusiness(
    dedupeCandidates(
      query.elements
        .map((element) => elementToCandidate(element, args.businessType))
        .filter((candidate): candidate is DiscoveredCandidate => candidate !== null)
    ),
    args.userBusinessName,
    args.userDomain
  );
  return {
    candidates,
    discoverySource: "overpass",
    status: "complete",
    queryPerformed: true,
    endpoint: query.endpoint,
    accessedAt: query.accessedAt,
  };
}
