const SOURCE_KINDS = new Set([
  "user_input",
  "nominatim",
  "openstreetmap",
  "homepage",
  "linked_page",
  "news_article",
]);
const SOURCE_STATUSES = new Set(["used", "limited", "unavailable"]);
const FORBIDDEN_SOURCE_VALUE = /mock|demo|synthetic/i;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function walk(value, visit, path = "report") {
  visit(value, path);
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, visit, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    walk(child, visit, `${path}.${key}`);
  }
}

function validateSourceReference(source, index) {
  const path = `provenance.sources[${index}]`;
  invariant(isRecord(source), `${path} must be an object`);
  invariant(source.id === `S${index + 1}`, `${path}.id must be S${index + 1}`);
  invariant(SOURCE_KINDS.has(source.kind), `${path}.kind is invalid`);
  invariant(typeof source.provider === "string" && source.provider.trim(), `${path}.provider is required`);
  invariant(typeof source.title === "string" && source.title.trim(), `${path}.title is required`);
  invariant(typeof source.accessedAt === "string" && !Number.isNaN(Date.parse(source.accessedAt)), `${path}.accessedAt is invalid`);
  invariant(SOURCE_STATUSES.has(source.status), `${path}.status is invalid`);
  if (source.url !== undefined) {
    invariant(typeof source.url === "string", `${path}.url must be a string`);
    const url = new URL(source.url);
    invariant(url.protocol === "https:" || url.protocol === "http:", `${path}.url must be public HTTP(S)`);
  }
}

function validateUnavailableAudit(entity, path) {
  if (entity.auditStatus !== "unavailable") return;
  invariant(entity.finalScore === null, `${path}.finalScore must be null when unavailable`);
  invariant(entity.rank === null, `${path}.rank must be null when unavailable`);
  const audit = entity.websiteAudit;
  if (!isRecord(audit)) return;
  for (const key of [
    "h1Count", "headingCount", "wordCount", "ctaCount", "hasPhone",
    "hasEmail", "hasContactPage", "hasBookingOrQuote", "hasPricingPage",
    "hasServicesPage", "hasAboutOrTeamPage", "hasBlogOrNewsPage",
    "hasCareersPage", "hasTestimonials", "hasTrustLanguage",
    "hasGalleryOrCaseStudy", "hasSocialLinks", "hasViewport", "isHttps",
    "htmlBytes", "fetchMs", "websiteScore",
  ]) {
    invariant(audit[key] === null, `${path}.websiteAudit.${key} must be null when unavailable`);
  }
}

export function validateRealReport(report) {
  invariant(isRecord(report), "report must be an object");
  invariant(report.schemaVersion === 2, "schemaVersion must be 2");
  invariant(report.provenance?.policy === "real-only", "provenance policy must be real-only");
  invariant(report.provenance?.containsSyntheticData === false, "containsSyntheticData must be false");
  invariant(Array.isArray(report.provenance?.sources) && report.provenance.sources.length > 0, "provenance.sources must not be empty");

  report.provenance.sources.forEach(validateSourceReference);
  const knownIds = new Set(report.provenance.sources.map((source) => source.id));
  const canonicalUrls = new Set();
  for (const source of report.provenance.sources) {
    if (!source.url) continue;
    const url = new URL(source.url);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
    const canonical = url.toString();
    invariant(!canonicalUrls.has(canonical), `duplicate canonical source URL: ${canonical}`);
    canonicalUrls.add(canonical);
  }

  let sourceIdArrayCount = 0;
  walk(report, (value, path) => {
    if (!isRecord(value)) return;
    invariant(!Object.hasOwn(value, "demoMode"), `${path}.demoMode is forbidden`);
    invariant(!Object.hasOwn(value, "usedMockData"), `${path}.usedMockData is forbidden`);
    for (const key of Object.keys(value)) {
      invariant(!/uplift/i.test(key), `${path}.${key} is a forbidden modeled uplift field`);
    }
    for (const key of ["source", "sourceType", "provider", "policy"]) {
      if (typeof value[key] === "string") {
        invariant(!FORBIDDEN_SOURCE_VALUE.test(value[key]), `${path}.${key} contains a synthetic source value`);
      }
    }
    if (Object.hasOwn(value, "sourceIds")) {
      sourceIdArrayCount += 1;
      invariant(Array.isArray(value.sourceIds), `${path}.sourceIds must be an array`);
      const mayBeEmptyBecauseUnavailable = value.auditStatus === "unavailable";
      invariant(
        value.sourceIds.length > 0 || mayBeEmptyBecauseUnavailable,
        `${path}.sourceIds must not be empty unless the observation is unavailable`
      );
      invariant(new Set(value.sourceIds).size === value.sourceIds.length, `${path}.sourceIds contains duplicates`);
      for (const sourceId of value.sourceIds) {
        invariant(knownIds.has(sourceId), `${path}.sourceIds contains unresolved ${sourceId}`);
      }
    }
  });
  invariant(sourceIdArrayCount > 0, "report has no source mappings");

  const entities = [report.user, ...(Array.isArray(report.competitors) ? report.competitors : [])];
  entities.forEach((entity, index) => {
    invariant(isRecord(entity), `entity ${index} is invalid`);
    validateUnavailableAudit(entity, index === 0 ? "user" : `competitors[${index - 1}]`);
    if (entity.rank !== null) {
      invariant(typeof entity.finalScore === "number", `ranked entity ${entity.name} must have a numeric finalScore`);
      invariant(entity.auditStatus !== "unavailable", `unavailable entity ${entity.name} must not be ranked`);
    }
  });
  const ranks = entities.map((entity) => entity.rank).filter((rank) => rank !== null).sort((a, b) => a - b);
  ranks.forEach((rank, index) => invariant(rank === index + 1, `rank sequence must be contiguous at ${index + 1}`));

  return { sourceCount: knownIds.size, scoredEntityCount: ranks.length };
}

export function validateSharedReportHtml(html, report) {
  // React may split server-rendered text with hydration comments, for example
  // `[<!-- -->S1<!-- -->]`. Remove comments before checking visible markers.
  const visibleHtml = html.replace(/<!--[\s\S]*?-->/g, "");
  invariant(/Sources Appendix/i.test(html), "shared report is missing Sources Appendix");
  invariant(/noindex/i.test(html) && /nofollow/i.test(html), "shared report is missing noindex,nofollow metadata");
  invariant(/property=["']og:title["']/i.test(html), "shared report is missing Open Graph title metadata");
  invariant(/property=["']og:description["']/i.test(html), "shared report is missing Open Graph description metadata");
  invariant(/\[S1\]/.test(visibleHtml), "shared report is missing visible source markers");
  const entities = report
    ? [report.user, ...(Array.isArray(report.competitors) ? report.competitors : [])]
    : [];
  if (
    report &&
    [
      report.user?.finalScore,
      report.user?.rank,
      report.summary?.yourRank,
      report.summary?.marketGap,
      report.summary?.competitorAverageWebsiteScore,
      report.summary?.competitorAverageFinalScore,
      ...entities.flatMap((entity) => [
        entity?.websiteAudit?.websiteScore,
        entity?.finalScore,
        entity?.rank,
      ]),
    ].some((value) => value === null)
  ) {
    invariant(/N\/A/.test(html), "shared report does not render unavailable values as N/A");
  }
  invariant(!/fallback demo|simulated data|source\W*[=:]\W*["']?mock/i.test(html), "shared report contains forbidden synthetic copy");
}
