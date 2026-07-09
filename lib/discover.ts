import { getMockCompetitors } from "./mock-data";
import { queryOverpass, type OverpassElement } from "./overpass";
import type { CompetitorReport } from "./types";

export type DiscoveredCandidate = {
  id: string;
  name: string;
  website?: string;
  phone?: string;
  address?: string;
  lat?: number;
  lon?: number;
  source: "overpass";
  priorityScore: number;
};

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function extractDomain(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    const normalized = url.startsWith("http") ? url : `https://${url}`;
    const host = new URL(normalized).hostname.replace(/^www\./, "");
    return host.toLowerCase();
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
  el: OverpassElement,
  businessType: string
): DiscoveredCandidate | null {
  const tags = el.tags ?? {};
  const name = tags.name;
  if (!name) return null;

  const website = tags.website ?? tags["contact:website"];
  const phone = tags.phone ?? tags["contact:phone"];
  const address = buildAddress(tags);
  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;

  let priorityScore = 0;
  if (website) priorityScore += 30;
  priorityScore += categoryRelevance(tags, businessType) * 2; // up to 20
  if (phone || tags["contact:email"] || tags.email) priorityScore += 20;
  if (address || (lat && lon)) priorityScore += 15;
  if (name.toLowerCase().includes(businessType.toLowerCase()))
    priorityScore += 10;
  priorityScore += Math.min(5, Object.keys(tags).length / 2);

  return {
    id: `osm-${el.type}-${el.id}`,
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

function dedupeCandidates(
  candidates: DiscoveredCandidate[]
): DiscoveredCandidate[] {
  const seen = new Map<string, DiscoveredCandidate>();

  for (const candidate of candidates) {
    const keys = [
      `name:${normalizeName(candidate.name)}|${
        candidate.address ? normalizeName(candidate.address) : ""
      }`,
      candidate.website ? `domain:${extractDomain(candidate.website)}` : "",
      candidate.phone ? `phone:${candidate.phone.replace(/\D/g, "")}` : "",
    ].filter(Boolean);

    const existingKey = keys.find((k) => seen.has(k));

    if (existingKey) {
      const existing = seen.get(existingKey)!;
      if (candidate.priorityScore > existing.priorityScore) {
        for (const k of keys) seen.set(k, candidate);
      }
      continue;
    }

    for (const k of keys) seen.set(k, candidate);
  }

  return Array.from(new Set(seen.values()));
}

export function removeUserBusiness(
  candidates: DiscoveredCandidate[],
  userBusinessName: string,
  userDomain?: string
): DiscoveredCandidate[] {
  const normalizedUserName = normalizeName(userBusinessName);

  return candidates.filter((c) => {
    const sameName = normalizeName(c.name) === normalizedUserName;
    const sameDomain =
      userDomain && extractDomain(c.website) === extractDomain(userDomain);
    return !sameName && !sameDomain;
  });
}

export async function discoverCompetitors(args: {
  businessType: string;
  market: string;
  userBusinessName: string;
  userDomain?: string;
  lat?: number;
  lon?: number;
  demoMode: "live" | "auto" | "mock";
}): Promise<{
  candidates: DiscoveredCandidate[];
  discoverySource: "overpass" | "mock" | "mixed";
  overpassFailed: boolean;
}> {
  const { businessType, userBusinessName, userDomain, lat, lon, demoMode } =
    args;

  if (demoMode === "mock" || lat === undefined || lon === undefined) {
    return { candidates: [], discoverySource: "mock", overpassFailed: false };
  }

  try {
    const elements = await queryOverpass(businessType, lat, lon);
    let candidates = elements
      .map((el) => elementToCandidate(el, businessType))
      .filter((c): c is DiscoveredCandidate => c !== null);

    candidates = dedupeCandidates(candidates);
    candidates = removeUserBusiness(candidates, userBusinessName, userDomain);
    candidates.sort((a, b) => b.priorityScore - a.priorityScore);

    return {
      candidates,
      discoverySource: "overpass",
      overpassFailed: false,
    };
  } catch (err) {
    console.warn(
      "Overpass discovery failed, falling back to mock competitors:",
      err instanceof Error ? err.message : err
    );
    return { candidates: [], discoverySource: "mock", overpassFailed: true };
  }
}

export async function mergeWithMockIfNeeded(args: {
  candidates: DiscoveredCandidate[];
  businessType: string;
  minLiveCompetitors: number;
  targetTotal: number;
}): Promise<{
  finalCandidates: (DiscoveredCandidate | { mock: true })[];
  mockCompetitors: CompetitorReport[];
  usedMockData: boolean;
}> {
  const { candidates, businessType, minLiveCompetitors, targetTotal } = args;

  const liveTop = candidates.slice(0, targetTotal);

  if (liveTop.length >= minLiveCompetitors) {
    return {
      finalCandidates: liveTop,
      mockCompetitors: [],
      usedMockData: false,
    };
  }

  const needed = targetTotal - liveTop.length;
  const mockCompetitors = await getMockCompetitors(businessType, needed);

  return {
    finalCandidates: liveTop,
    mockCompetitors,
    usedMockData: true,
  };
}
