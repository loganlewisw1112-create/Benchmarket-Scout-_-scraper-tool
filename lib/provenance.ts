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

export class ProvenanceRegistry {
  private readonly accessedAt: string;
  private readonly sources: SourceReference[] = [];
  private readonly idByKey = new Map<string, SourceId>();
  private readonly idByCanonicalUrl = new Map<string, SourceId>();

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
    return id;
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
    Object.assign(source, patch);
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
