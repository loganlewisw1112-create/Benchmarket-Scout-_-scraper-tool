import catalogJson from "@/data/real-samples/catalog.json";
import type { AnalyzeMarketRequest } from "./types";

export const SAMPLE_INDUSTRIES = [
  "HVAC",
  "bakery",
  "dentistry",
  "plumbing",
  "landscaping",
  "law",
  "yoga",
  "auto detailing",
  "pet grooming",
  "restaurants",
  "cafes",
  "veterinary",
  "physical therapy",
  "chiropractic",
  "barbering",
  "hair salons",
  "electrical",
  "roofing",
  "florists",
  "accounting",
  "real estate",
  "cleaning",
  "gyms",
  "daycare",
  "photography",
] as const;

export type SampleIndustry = (typeof SAMPLE_INDUSTRIES)[number];

export type SampleCatalogEntry = AnalyzeMarketRequest & {
  id: string;
  industry: SampleIndustry;
};

const CATALOG_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function validateCatalog(value: unknown): readonly SampleCatalogEntry[] {
  if (!Array.isArray(value) || value.length !== SAMPLE_INDUSTRIES.length) {
    throw new Error(`Real sample catalog must contain exactly ${SAMPLE_INDUSTRIES.length} entries.`);
  }

  const ids = new Set<string>();
  const industries = new Set<string>();
  const entries = value.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object") {
      throw new Error(`Real sample catalog entry ${index} is invalid.`);
    }
    const entry = candidate as Record<string, unknown>;
    for (const field of [
      "id",
      "industry",
      "businessName",
      "businessUrl",
      "businessType",
      "market",
    ]) {
      if (typeof entry[field] !== "string" || !entry[field].trim()) {
        throw new Error(`Real sample catalog entry ${index} has an invalid ${field}.`);
      }
    }
    if (!CATALOG_ID_PATTERN.test(String(entry.id))) {
      throw new Error(`Real sample catalog entry ${index} has an invalid id.`);
    }
    if (ids.has(String(entry.id))) throw new Error(`Duplicate real sample catalog id ${entry.id}.`);
    if (industries.has(String(entry.industry))) {
      throw new Error(`Duplicate real sample industry ${entry.industry}.`);
    }
    let url: URL;
    try {
      url = new URL(String(entry.businessUrl));
    } catch {
      throw new Error(`Real sample catalog entry ${entry.id} has an invalid URL.`);
    }
    if (url.protocol !== "https:") {
      throw new Error(`Real sample catalog entry ${entry.id} must use HTTPS.`);
    }
    ids.add(String(entry.id));
    industries.add(String(entry.industry));
    return Object.freeze(entry as unknown as SampleCatalogEntry);
  });

  for (const industry of SAMPLE_INDUSTRIES) {
    if (!industries.has(industry)) throw new Error(`Missing real sample industry ${industry}.`);
  }
  return Object.freeze(entries);
}

export const SAMPLE_CATALOG = validateCatalog(catalogJson);

export function getSampleCatalogEntry(id: string): SampleCatalogEntry | null {
  return SAMPLE_CATALOG.find((entry) => entry.id === id) ?? null;
}
