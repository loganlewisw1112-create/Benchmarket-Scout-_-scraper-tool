import type {
  Provenance,
  SourceReference,
  SourceId,
} from "./types";

export type SourceReferenceInput = Omit<SourceReference, "id" | "accessedAt"> & {
  accessedAt?: string;
};

function canonicalUrl(url?: string): string {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.pathname = parsed.pathname.replace(/\/$/, "") || "/";
    return parsed.toString();
  } catch {
    return url.trim().toLowerCase();
  }
}

function canonicalKey(source: SourceReferenceInput): string {
  return [
    source.kind,
    source.provider,
    canonicalUrl(source.url),
    source.title.trim().toLowerCase(),
    source.businessName?.trim().toLowerCase() ?? "",
  ].join("|");
}

const STATUS_RANK: Record<SourceReference["status"], number> = {
  used: 2,
  limited: 1,
  unavailable: 0,
};

export class ProvenanceRegistry {
  private readonly accessedAt: string;
  private readonly sources: SourceReference[] = [];
  private readonly idByKey = new Map<string, SourceId>();
  private readonly idByCanonicalUrl = new Map<string, SourceId>();
  // Every business a URL-deduplicated source was registered for.
  private readonly businessesById = new Map<SourceId, string[]>();

  constructor(accessedAt: string = new Date().toISOString()) {
    this.accessedAt = accessedAt;
  }

  add(input: SourceReferenceInput): SourceId {
    const key = canonicalKey(input);
    const existing = this.idByKey.get(key);
    if (existing) return existing;

    const normalizedUrl = canonicalUrl(input.url);
    const existingUrl = normalizedUrl
      ? this.idByCanonicalUrl.get(normalizedUrl)
      : undefined;
    if (existingUrl) {
      this.idByKey.set(key, existingUrl);
      this.noteBusiness(existingUrl, input.businessName);
      return existingUrl;
    }

    const id = `S${this.sources.length + 1}` as SourceId;
    this.idByKey.set(key, id);
    if (normalizedUrl) this.idByCanonicalUrl.set(normalizedUrl, id);
    const { accessedAt, ...source } = input;
    this.sources.push({
      id,
      ...source,
      accessedAt: accessedAt ?? this.accessedAt,
    });
    if (input.businessName?.trim()) {
      this.businessesById.set(id, [input.businessName.trim()]);
    }
    return id;
  }

  /**
   * One URL registered for two different businesses (e.g. two listings whose
   * sites redirect to one franchisor page) is one source, but it must not be
   * attributed to whichever business happened to register it first: the
   * entry drops its single businessName and names every business it covers.
   */
  private noteBusiness(id: SourceId, businessName?: string): void {
    const name = businessName?.trim();
    if (!name) return;
    const names = this.businessesById.get(id) ?? [];
    if (names.some((existing) => existing.toLowerCase() === name.toLowerCase())) return;
    names.push(name);
    this.businessesById.set(id, names);
    const source = this.sources.find((candidate) => candidate.id === id);
    if (!source || names.length < 2) return;
    delete source.businessName;
    source.title = `Page shared by ${names.length} businesses: ${names.join(", ")}`;
  }

  update(
    id: SourceId,
    patch: Partial<
      Pick<
        SourceReference,
        "status" | "title" | "businessName" | "accessedAt"
      >
    >
  ): void {
    const source = this.sources.find((candidate) => candidate.id === id);
    if (!source) throw new Error(`Unknown provenance source ID ${id}.`);
    if ((this.businessesById.get(id)?.length ?? 0) < 2) {
      Object.assign(source, patch);
      return;
    }
    // A shared source keeps its neutral attribution, and one business's
    // failed fetch never downgrades a page another business's audit used.
    if (patch.accessedAt !== undefined) source.accessedAt = patch.accessedAt;
    if (patch.status !== undefined && STATUS_RANK[patch.status] > STATUS_RANK[source.status]) {
      source.status = patch.status;
    }
  }

  build(): Provenance {
    return {
      policy: "real-only",
      containsSyntheticData: false,
      sources: this.sources.map((source) => ({ ...source })),
    };
  }
}

export function dedupeSourceIds(ids: readonly SourceId[]): SourceId[] {
  return [...new Set(ids)];
}
