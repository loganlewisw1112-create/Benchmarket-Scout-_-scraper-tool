import * as cheerio from "cheerio";
import { CACHE_TTL, readCache, writeCache } from "./cache";
import { isPathAllowed } from "./robots";
import {
  KEYWORDS,
  countKeywordMatches,
  extractSocialLinksFromHrefs,
  isSocialNetworkUrl,
} from "./signals";
import type {
  AuditFailureCode,
  EvidenceItem,
  ExtractedLink,
  SourceId,
  WebsiteAudit,
} from "./types";
import {
  createPinnedHttpTargetResult,
  normalizeHttpUrl,
  urlSafetyReasonOf,
  type PinnedHttpTarget,
  type UrlSafetyReason,
} from "./url-safety";
import type { Dispatcher } from "undici";
import {
  abortable,
  createTimedSignal,
  remainingBudgetMs,
  type RequestBudgetOptions,
} from "./time-budget";

const USER_AGENT =
  process.env.APP_USER_AGENT ??
  "BenchmarkScout/0.1 (contact: github.com/loganlewisw1112-create/Benchmarket-Scout-_-scraper-tool)";

const MAX_HTML_BYTES = 1.5 * 1024 * 1024;
// Covers DNS pinning plus the HTTP exchanges for one page (all redirect
// hops). The robots.txt check has its own budget and is not counted here.
const PAGE_FETCH_BUDGET_MS = 5_000;
// robots.txt is usually cached per origin; a slow or hanging one fails open
// after this long instead of eating the page budget.
const ROBOTS_CHECK_BUDGET_MS = 1_500;
const MAX_REDIRECTS = 3;
// A homepage with fewer visible words than this (a JS-only shell, a
// meta-refresh stub, an empty page) has nothing to audit, so it is reported
// as a failed audit instead of being scored as a weak website.
const MIN_AUDIT_WORDS = 40;

export type PageText = {
  url: string;
  text: string;
  sourceType: "homepage" | "linked_page";
  sourceIds: SourceId[];
};

export type LinkedPageAttempt = {
  url: string;
  status: "used" | "unavailable";
  reason?: string;
  reasonCode?: AuditFailureCode;
  accessedAt: string;
};

export type AuditResult = {
  audit: WebsiteAudit;
  pageTexts: PageText[];
  linkedPageAttempts: LinkedPageAttempt[];
  accessedAt: string;
};

/**
 * User-facing text for each audit failure code. Raw error strings and exact
 * status codes are never stored: they would leak a port/status oracle about
 * the target (SEC-6) and read as noise in a report.
 */
export function auditFailureText(
  code: AuditFailureCode,
  detail: { statusClass?: string } = {}
): string {
  switch (code) {
    case "timeout":
      return "Audit time budget exhausted";
    case "blocked_by_site":
      return "Site refused automated access";
    case "http_error":
      return detail.statusClass
        ? `Site returned an HTTP ${detail.statusClass} error`
        : "Site returned an HTTP error";
    case "dns_unresolved":
      return "Domain does not resolve";
    case "dns_error":
      return "Domain lookup failed";
    case "tls_error":
      return "Secure connection (TLS) failed";
    case "connection_failed":
      return "Could not connect to the site";
    case "too_large":
      return "Response too large";
    case "unsupported_content_type":
      return "Non-HTML content type";
    case "insufficient_content":
      return "Too little readable page content to audit (the page may require JavaScript or only redirect elsewhere)";
    case "robots_disallowed":
      return "Disallowed by robots.txt";
    case "too_many_redirects":
      return "Too many redirects";
    case "invalid_url":
      return "Invalid URL";
    case "blocked_url":
      return "URL failed public safety check";
  }
}

/** Collapses a url-safety refusal (contract 4) into an audit failure code. */
export function auditFailureCodeForUrlSafety(
  reason: UrlSafetyReason
): AuditFailureCode {
  switch (reason) {
    case "dns_unresolved":
      return "dns_unresolved";
    case "dns_error":
      return "dns_error";
    case "invalid_url":
      return "invalid_url";
    case "unsupported_scheme":
    case "credentials_in_url":
    case "blocked_port":
    case "blocked_host":
    case "private_address":
      return "blocked_url";
  }
}

/** User-facing text for a url-safety refusal ("Domain does not resolve", ...). */
export function describeUrlSafetyReason(reason: UrlSafetyReason): string {
  return auditFailureText(auditFailureCodeForUrlSafety(reason));
}

type FetchFailure = { ok: false; code: AuditFailureCode; reason: string };

type FetchOutcome =
  | { ok: true; html: string; finalUrl: string; bytes: number; ms: number }
  | FetchFailure;

function fetchFailure(
  code: AuditFailureCode,
  detail?: { statusClass?: string }
): FetchFailure {
  return { ok: false, code, reason: auditFailureText(code, detail) };
}

function httpStatusFailure(status: number): FetchFailure {
  if (status === 403 || status === 429) return fetchFailure("blocked_by_site");
  return fetchFailure("http_error", {
    statusClass: `${Math.floor(status / 100)}xx`,
  });
}

function errorCodes(err: unknown): string[] {
  const codes: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") codes.push(code.toUpperCase());
    current = (current as { cause?: unknown }).cause;
  }
  return codes;
}

/** Maps a thrown fetch/undici error to the small generic failure set. */
function classifyFetchError(err: unknown): AuditFailureCode {
  const codes = errorCodes(err);
  if (codes.some((c) => c === "ENOTFOUND" || c === "EAI_NONAME")) {
    return "dns_unresolved";
  }
  if (codes.some((c) => /TIMEOUT|ETIMEDOUT/.test(c))) return "timeout";
  if (
    codes.some((c) =>
      /CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|EPROTO/.test(c)
    )
  ) {
    return "tls_error";
  }
  return "connection_failed";
}

function isHtmlContentType(contentType: string): boolean {
  const lower = contentType.toLowerCase();
  return lower.includes("text/html") || lower.includes("application/xhtml+xml");
}

function charsetFromContentType(contentType: string): string | undefined {
  return /charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(contentType)?.[1];
}

// Looks for <meta charset> / http-equiv content-type in the first bytes. Only
// consulted when the header does not name a charset.
function charsetFromMeta(bytes: Uint8Array): string | undefined {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 2048));
  return /<meta[^>]+charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(head)?.[1];
}

function decodeHtml(bytes: Uint8Array, contentType: string): string {
  const label = charsetFromContentType(contentType) ?? charsetFromMeta(bytes);
  if (label) {
    try {
      return new TextDecoder(label).decode(bytes);
    } catch {
      // Unknown label: fall through to UTF-8.
    }
  }
  return new TextDecoder("utf-8").decode(bytes);
}

async function pinTarget(
  url: string,
  parentSignal: AbortSignal | undefined,
  budgetMs: number
): Promise<{ ok: true; target: PinnedHttpTarget } | FetchFailure> {
  if (parentSignal?.aborted || budgetMs <= 0) return fetchFailure("timeout");
  const timed = createTimedSignal(parentSignal, budgetMs);
  try {
    const result = await abortable(
      createPinnedHttpTargetResult(url, timed.signal),
      timed.signal
    );
    if (result.ok) return result;
    return fetchFailure(auditFailureCodeForUrlSafety(result.reason));
  } catch {
    // createPinnedHttpTargetResult only rejects when the signal aborts.
    return fetchFailure("timeout");
  } finally {
    timed.cleanup();
  }
}

/**
 * robots.txt gate with its own small budget. It fails open (allowed) when
 * robots.txt is slow, unreachable, or errors, as documented in lib/robots.ts.
 * Returns "aborted" only when the caller's own deadline has passed.
 */
async function checkRobots(
  url: string,
  parentSignal: AbortSignal | undefined,
  budgetMs: number
): Promise<boolean | "aborted"> {
  if (parentSignal?.aborted || budgetMs <= 0) return "aborted";
  const timed = createTimedSignal(parentSignal, budgetMs);
  try {
    return await abortable(isPathAllowed(url, timed.signal), timed.signal);
  } catch {
    return parentSignal?.aborted ? "aborted" : true;
  } finally {
    timed.cleanup();
  }
}

async function safeFetchHtml(
  rawUrl: string,
  options: RequestBudgetOptions = {}
): Promise<FetchOutcome> {
  if (options.signal?.aborted || (options.budgetMs ?? 1) <= 0) {
    return fetchFailure("timeout");
  }
  const startedAt = Date.now();
  const overallBudgetMs = options.budgetMs ?? Number.POSITIVE_INFINITY;
  const pageBudgetMs = Math.min(PAGE_FETCH_BUDGET_MS, overallBudgetMs);
  // pageSpentMs: DNS pinning + HTTP time, charged to the page budget.
  // fetchMs: HTTP request/response time only (the speed metric). Neither
  // includes the robots.txt check.
  let pageSpentMs = 0;
  let fetchMs = 0;
  const overallRemaining = () => overallBudgetMs - (Date.now() - startedAt);
  const pageRemaining = () =>
    Math.min(pageBudgetMs - pageSpentMs, overallRemaining());
  let currentUrl = rawUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let normalized: string;
    try {
      normalized = normalizeHttpUrl(currentUrl);
    } catch (err) {
      return fetchFailure(auditFailureCodeForUrlSafety(urlSafetyReasonOf(err)));
    }

    const pinStartedAt = Date.now();
    const pinned = await pinTarget(normalized, options.signal, pageRemaining());
    pageSpentMs += Date.now() - pinStartedAt;
    if (!pinned.ok) return pinned;
    const pinnedTarget = pinned.target;

    // No-op unless STRICT_ROBOTS=true; covers homepage, linked pages, and
    // every redirect hop since each pass through this loop re-checks.
    const robotsAllowed = await checkRobots(
      normalized,
      options.signal,
      Math.min(ROBOTS_CHECK_BUDGET_MS, overallRemaining())
    );
    if (robotsAllowed !== true) {
      await pinnedTarget.close();
      return fetchFailure(
        robotsAllowed === "aborted" ? "timeout" : "robots_disallowed"
      );
    }

    const requestBudgetMs = pageRemaining();
    if (options.signal?.aborted || requestBudgetMs <= 0) {
      await pinnedTarget.close();
      return fetchFailure("timeout");
    }
    const timed = createTimedSignal(options.signal, requestBudgetMs);
    const requestStartedAt = Date.now();

    try {
      const res = await fetch(normalized, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml",
        },
        redirect: "manual",
        signal: timed.signal,
        dispatcher: pinnedTarget.dispatcher,
      } as RequestInit & { dispatcher: Dispatcher });

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location) {
          return httpStatusFailure(res.status);
        }
        await res.body?.cancel();
        currentUrl = new URL(location, normalized).toString();
        continue;
      }

      if (!res.ok) {
        return httpStatusFailure(res.status);
      }

      const contentType = res.headers.get("content-type") ?? "";
      if (!isHtmlContentType(contentType)) {
        return fetchFailure("unsupported_content_type");
      }

      const contentLength = res.headers.get("content-length");
      if (contentLength && parseInt(contentLength, 10) > MAX_HTML_BYTES) {
        return fetchFailure("too_large");
      }

      if (!res.body) {
        const html = await res.text();
        return {
          ok: true,
          html,
          finalUrl: normalized,
          bytes: html.length,
          ms: fetchMs + (Date.now() - requestStartedAt),
        };
      }

      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let received = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          received += value.byteLength;
          if (received > MAX_HTML_BYTES) {
            reader.cancel();
            break;
          }
          chunks.push(value);
        }
      }

      const html = decodeHtml(Buffer.concat(chunks), contentType);
      return {
        ok: true,
        html,
        finalUrl: normalized,
        bytes: received,
        ms: fetchMs + (Date.now() - requestStartedAt),
      };
    } catch (err) {
      if (timed.signal.aborted) {
        return fetchFailure("timeout");
      }
      return fetchFailure(classifyFetchError(err));
    } finally {
      const elapsed = Date.now() - requestStartedAt;
      fetchMs += elapsed;
      pageSpentMs += elapsed;
      timed.cleanup();
      await pinnedTarget.close();
    }
  }

  return fetchFailure("too_many_redirects");
}

// Minimal structural view of cheerio's (domhandler) nodes, enough to walk
// the tree without depending on domhandler's types directly.
type DomNode = {
  type: string;
  name?: string;
  data?: string;
  attribs?: Record<string, string>;
  children?: DomNode[];
};

// Elements whose text is never visible page copy.
const NON_TEXT_TAGS = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "canvas",
  "iframe",
  "object",
  "select",
]);

// Inline elements do not break words; every other element is treated as a
// block and separated by whitespace, so "<li>Home</li><li>Locations</li>"
// reads "Home Locations" instead of "HomeLocations".
const INLINE_TAGS = new Set([
  "a",
  "abbr",
  "b",
  "bdi",
  "bdo",
  "cite",
  "code",
  "data",
  "dfn",
  "em",
  "font",
  "i",
  "kbd",
  "mark",
  "q",
  "s",
  "samp",
  "small",
  "span",
  "strong",
  "sub",
  "sup",
  "time",
  "u",
  "var",
]);

// Site chrome whose words are boilerplate repeated on every page (menus,
// "Careers" / "Leadership" footer links, cookie asides). Excluded from the
// text used for momentum/risk/change/offer/hiring signals.
const CHROME_TAGS = new Set(["nav", "aside"]);
const CHROME_ROLES = new Set(["navigation", "banner", "contentinfo", "complementary"]);
// header/footer are site chrome only when not inside sectioning content;
// an <article>'s own <header> is part of that article (HTML-AAM).
const SECTIONING_TAGS = new Set(["article", "aside", "main", "nav", "section"]);

function extractVisibleText(body: DomNode | undefined): {
  fullText: string;
  contentText: string;
} {
  const full: string[] = [];
  const content: string[] = [];

  const walk = (node: DomNode, inChrome: boolean, inSection: boolean) => {
    if (node.type === "text") {
      const text = node.data ?? "";
      full.push(text);
      if (!inChrome) content.push(text);
      return;
    }
    if (node.type !== "tag" && node.type !== "root") return;

    const name = node.name?.toLowerCase() ?? "";
    if (NON_TEXT_TAGS.has(name)) return;
    if (node.attribs && "hidden" in node.attribs) return;

    const role = node.attribs?.role?.toLowerCase() ?? "";
    const isChrome =
      CHROME_TAGS.has(name) ||
      CHROME_ROLES.has(role) ||
      ((name === "header" || name === "footer") && !inSection);
    const block = node.type === "tag" && !INLINE_TAGS.has(name);

    if (block) {
      full.push(" ");
      content.push(" ");
    }
    for (const child of node.children ?? []) {
      walk(child, inChrome || isChrome, inSection || SECTIONING_TAGS.has(name));
    }
    if (block) {
      full.push(" ");
      content.push(" ");
    }
  };

  if (body) walk(body, false, false);
  const clean = (parts: string[]) => parts.join("").replace(/\s+/g, " ").trim();
  return { fullText: clean(full), contentText: clean(content) };
}

function countWords(text: string): number {
  return text ? text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length : 0;
}

function hostWithoutWww(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
}

/** Same host, or one is a subdomain of the other (www-insensitive). */
function isSameSite(a: string, b: string): boolean {
  try {
    const ha = hostWithoutWww(new URL(a).hostname);
    const hb = hostWithoutWww(new URL(b).hostname);
    return ha === hb || ha.endsWith(`.${hb}`) || hb.endsWith(`.${ha}`);
  } catch {
    return false;
  }
}

/**
 * Classifies a link by whole words in its path and label, never by
 * substrings: "WordPress", "Espresso" and "Compressor" are not "press",
 * "Facebook" and "Bookkeeping" are not "book", "wix.com" is not "x.com".
 * Page-type flags come from same-site links only, so a theme or platform
 * credit ("Proudly powered by WordPress") cannot mark a site as having a
 * blog. Booking and quote links may be external (third-party schedulers).
 */
function classifyLink(
  href: string,
  label: string,
  pageUrl: string
): ExtractedLink["type"] {
  if (isSocialNetworkUrl(href)) return "social";

  let path = "";
  try {
    const url = new URL(href);
    path = `${url.pathname} ${url.search}`;
  } catch {
    return "other";
  }
  const words = ` ${`${path} ${label}`.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  const has = (pattern: RegExp) => pattern.test(words);

  if (has(/ (book|booking|schedule|appointment|appointments) /)) {
    return "booking";
  }
  if (has(/ (quote|quotes|estimate|estimates) /)) return "quote";
  if (!isSameSite(href, pageUrl)) return "other";

  if (has(/ (contact|contact us) /)) return "contact";
  if (has(/ (pricing|prices|packages) /)) return "pricing";
  if (has(/ (service|services) /)) return "services";
  if (has(/ (about|about us|team|our story|who we are) /)) return "about";
  if (has(/ (blog|news|press|articles) /)) return "blog";
  if (has(/ (career|careers|jobs|join our team|employment) /)) return "careers";
  return "other";
}

const PHONE_REGEX = /(\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/;
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

/** Target of a <meta http-equiv="refresh" content="N; url=..."> tag. */
function metaRefreshTarget(
  $: cheerio.CheerioAPI,
  pageUrl: string
): string | undefined {
  const tag = $("meta[http-equiv]")
    .toArray()
    .find((el) => $(el).attr("http-equiv")?.trim().toLowerCase() === "refresh");
  const content = tag ? $(tag).attr("content") : undefined;
  if (!content) return undefined;

  const match = /^\s*\d*(?:\.\d*)?\s*[;,]?\s*(?:url\s*=\s*)?(.*)$/i.exec(content);
  const raw = match?.[1]?.trim().replace(/^["']|["']$/g, "").trim();
  if (!raw) return undefined;
  try {
    const target = new URL(raw, pageUrl);
    return target.protocol === "http:" || target.protocol === "https:"
      ? target.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function parseHtml(html: string, pageUrl: string) {
  const $ = cheerio.load(html);

  const metaRefreshUrl = metaRefreshTarget($, pageUrl);
  $("script, style, noscript").remove();

  const { fullText: bodyText, contentText } = extractVisibleText(
    $("body").get(0) as unknown as DomNode | undefined
  );
  const title = $("title").first().text().trim() || undefined;
  const metaDescription =
    $('meta[name="description"]').attr("content")?.trim() || undefined;
  const h1Count = $("h1").length;
  const headingCount = $("h1, h2, h3, h4, h5, h6").length;
  const wordCount = countWords(bodyText);
  const hasViewport = $('meta[name="viewport"]').length > 0;

  const links: ExtractedLink[] = [];
  const hrefs: string[] = [];
  let hasTelLink = false;
  let hasMailtoLink = false;

  $("a[href]").each((_, el) => {
    const hrefRaw = $(el).attr("href")?.trim();
    if (!hrefRaw) return;
    if (/^tel:/i.test(hrefRaw)) {
      hasTelLink = true;
      return;
    }
    if (/^mailto:/i.test(hrefRaw)) {
      hasMailtoLink = true;
      return;
    }

    let absolute: URL;
    try {
      absolute = new URL(hrefRaw, pageUrl);
    } catch {
      return;
    }
    // Only web links are stored; javascript:, data:, etc. are dropped.
    if (absolute.protocol !== "http:" && absolute.protocol !== "https:") return;

    const href = absolute.toString();
    const label = $(el).text().replace(/\s+/g, " ").trim().slice(0, 60);
    hrefs.push(href);
    links.push({ label, href, type: classifyLink(href, label, pageUrl) });
  });

  return {
    $,
    bodyText,
    contentText,
    title,
    metaDescription,
    h1Count,
    headingCount,
    wordCount,
    hasViewport,
    links,
    hrefs,
    metaRefreshUrl,
    hasPhone: hasTelLink || PHONE_REGEX.test(bodyText),
    hasEmail: hasMailtoLink || EMAIL_REGEX.test(bodyText),
  };
}

type ParsedPage = ReturnType<typeof parseHtml>;

function hasAuditableContent(page: ParsedPage): boolean {
  return page.wordCount >= MIN_AUDIT_WORDS;
}

function pickInternalLinksToFollow(
  links: ExtractedLink[],
  baseHost: string
): ExtractedLink[] {
  const priority: ExtractedLink["type"][] = [
    "about",
    "services",
    "careers",
    "blog",
    "contact",
  ];

  const candidates = links.filter((link) => {
    try {
      return new URL(link.href).hostname.replace(/^www\./, "") === baseHost;
    } catch {
      return false;
    }
  });

  const chosen: ExtractedLink[] = [];
  for (const type of priority) {
    const match = candidates.find((l) => l.type === type);
    if (match && !chosen.some((c) => c.href === match.href)) {
      chosen.push(match);
    }
    if (chosen.length >= 2) break;
  }

  return chosen.slice(0, 2);
}

function computeScoreBreakdown(fields: {
  title?: string;
  metaDescription?: string;
  h1Count: number;
  wordCount: number;
  businessType: string;
  market: string;
  bodyText: string;
  ctaCount: number;
  hasPhone: boolean;
  hasEmail: boolean;
  hasContactPage: boolean;
  hasBookingOrQuote: boolean;
  hasServicesPage: boolean;
  hasPricingPage: boolean;
  hasTestimonials: boolean;
  hasTrustLanguage: boolean;
  hasAboutOrTeamPage: boolean;
  hasGalleryOrCaseStudy: boolean;
  hasBlogOrNewsPage: boolean;
  headingCount: number;
  hasViewport: boolean;
  fetchMs: number;
  htmlBytes: number;
  isHttps: boolean;
}) {
  let seo = 0;
  if (fields.title) seo += 5;
  if (fields.metaDescription) seo += 5;
  if (fields.h1Count > 0) seo += 5;
  if (fields.wordCount >= 300) seo += 5;
  const cityWord = fields.market.split(",")[0]?.trim().toLowerCase();
  const haystack = `${fields.title ?? ""} ${fields.metaDescription ?? ""} ${fields.bodyText}`.toLowerCase();
  if (
    haystack.includes(fields.businessType.toLowerCase()) ||
    (cityWord && haystack.includes(cityWord))
  )
    seo += 5;

  let conversion = 0;
  if (fields.ctaCount >= 2) conversion += 8;
  if (fields.hasPhone || fields.hasEmail) conversion += 7;
  if (fields.hasContactPage || fields.hasBookingOrQuote) conversion += 5;
  if (fields.hasServicesPage || fields.hasPricingPage) conversion += 5;

  let trust = 0;
  if (fields.hasTestimonials) trust += 8;
  if (fields.hasTrustLanguage) trust += 4;
  if (fields.hasAboutOrTeamPage) trust += 4;
  if (fields.hasGalleryOrCaseStudy) trust += 4;

  let content = 0;
  if (fields.hasServicesPage) content += 8;
  if (fields.hasBlogOrNewsPage) content += 4;
  if (fields.headingCount >= 3) content += 4;
  if (cityWord && haystack.includes(cityWord)) content += 4;

  let technical = 0;
  if (fields.hasViewport) technical += 3;
  if (fields.fetchMs < 2500) technical += 3;
  if (fields.htmlBytes < 1024 * 1024) technical += 2;
  if (fields.isHttps) technical += 2;

  return {
    seo: Math.min(25, seo),
    conversion: Math.min(25, conversion),
    trust: Math.min(20, trust),
    content: Math.min(20, content),
    technical: Math.min(10, technical),
  };
}

export function skippedAudit(
  url: string | undefined,
  reason: string,
  sourceIds: SourceId[] = [],
  accessedAt: string = new Date().toISOString(),
  reasonCode?: AuditFailureCode
): AuditResult {
  return {
    audit: {
      url,
      auditStatus: "unavailable",
      skipped: true,
      reason,
      ...(reasonCode ? { reasonCode } : {}),
      sourceIds,
      h1Count: null,
      headingCount: null,
      wordCount: null,
      ctaCount: null,
      hasPhone: null,
      hasEmail: null,
      hasContactPage: null,
      hasBookingOrQuote: null,
      hasPricingPage: null,
      hasServicesPage: null,
      hasAboutOrTeamPage: null,
      hasBlogOrNewsPage: null,
      hasCareersPage: null,
      hasTestimonials: null,
      hasTrustLanguage: null,
      hasGalleryOrCaseStudy: null,
      hasSocialLinks: null,
      hasViewport: null,
      isHttps: null,
      htmlBytes: null,
      fetchMs: null,
      extractedLinks: [],
      socialLinks: {},
      websiteScore: null,
      scoreBreakdown: {
        seo: null,
        conversion: null,
        trust: null,
        content: null,
        technical: null,
      },
      evidence: sourceIds.length
        ? [
            {
              claim: `Website audit unavailable: ${reason}.`,
              sourceUrl: url,
              sourceType: "homepage",
              sourceIds,
              confidence: "low",
            },
          ]
        : [],
    },
    pageTexts: [],
    linkedPageAttempts: [],
    accessedAt,
  };
}

export async function auditWebsite(args: {
  url: string;
  businessType: string;
  market: string;
  sourceId: SourceId;
  signal?: AbortSignal;
  budgetMs?: number;
}): Promise<AuditResult> {
  const { url, businessType, market, sourceId } = args;
  const accessedAt = new Date().toISOString();
  const deadlineAt = Date.now() + (args.budgetMs ?? 15_000);

  if (args.signal?.aborted) {
    return skippedAudit(
      url,
      "analysis time budget exhausted before website audit",
      [sourceId],
      accessedAt,
      "timeout"
    );
  }

  let normalized: string;
  try {
    normalized = normalizeHttpUrl(url);
  } catch (err) {
    const code = auditFailureCodeForUrlSafety(urlSafetyReasonOf(err));
    return skippedAudit(url, auditFailureText(code), [sourceId], accessedAt, code);
  }

  // v4: content-empty pages became failed audits and signal/link extraction
  // changed, so v3 entries must not be served.
  const cacheKey = `v4:homepage:${normalized}:${businessType.toLowerCase()}:${market.toLowerCase()}`;
  const cached = await readCache<AuditResult>(
    "homepages",
    cacheKey,
    CACHE_TTL.homepages
  );
  if (
    cached?.audit.auditStatus &&
    cached.audit.websiteScore !== undefined &&
    Array.isArray(cached.linkedPageAttempts) &&
    typeof cached.accessedAt === "string" &&
    !Number.isNaN(Date.parse(cached.accessedAt))
  ) {
    return {
      audit: {
        ...cached.audit,
        sourceIds: [sourceId],
        evidence: cached.audit.evidence.map((item) => ({
          ...item,
          sourceIds: [sourceId],
        })),
      },
      pageTexts: cached.pageTexts.map((page) => ({
        ...page,
        sourceIds: [sourceId],
      })),
      linkedPageAttempts: cached.linkedPageAttempts,
      accessedAt: cached.accessedAt,
    };
  }

  let outcome = await safeFetchHtml(normalized, {
    signal: args.signal,
    budgetMs: remainingBudgetMs(deadlineAt),
  });
  if (!outcome.ok) {
    return skippedAudit(
      normalized,
      outcome.reason,
      [sourceId],
      accessedAt,
      outcome.code
    );
  }

  let parsedHome = parseHtml(outcome.html, outcome.finalUrl);

  // A content-empty page that meta-refreshes within the same site is
  // followed once, through the same SSRF-safe fetch path as a 3xx redirect.
  // A refresh to another site (e.g. a parked or sold domain) is not.
  const refreshUrl = parsedHome.metaRefreshUrl;
  if (
    !hasAuditableContent(parsedHome) &&
    refreshUrl &&
    refreshUrl !== outcome.finalUrl &&
    isSameSite(refreshUrl, outcome.finalUrl)
  ) {
    const refreshed = await safeFetchHtml(refreshUrl, {
      signal: args.signal,
      budgetMs: remainingBudgetMs(deadlineAt),
    });
    if (!refreshed.ok) {
      return skippedAudit(
        normalized,
        refreshed.reason,
        [sourceId],
        accessedAt,
        refreshed.code
      );
    }
    outcome = { ...refreshed, ms: outcome.ms + refreshed.ms };
    parsedHome = parseHtml(outcome.html, outcome.finalUrl);
  }

  // JS-only shells, meta-refresh stubs and empty pages carry no observable
  // website content. Scoring them would rank a site nobody could read.
  if (!hasAuditableContent(parsedHome)) {
    return skippedAudit(
      normalized,
      auditFailureText("insufficient_content"),
      [sourceId],
      accessedAt,
      "insufficient_content"
    );
  }

  const baseHost = new URL(outcome.finalUrl).hostname.replace(/^www\./, "");

  const ctaCount = countKeywordMatches(parsedHome.bodyText, KEYWORDS.cta);
  // Whole-word matches only: "preview" is not a review, "uninsured" is not
  // "insured". "results" was dropped: it mostly matched "search results".
  const testimonialHits = countKeywordMatches(parsedHome.bodyText, [
    "testimonial",
    "review",
    "case study",
  ]);
  const trustLanguageHits = countKeywordMatches(parsedHome.bodyText, [
    "certified",
    "licensed",
    "insured",
    "award",
    "guaranteed",
    "trusted",
  ]);
  const galleryHits = countKeywordMatches(parsedHome.bodyText, [
    "gallery",
    "case study",
    "portfolio",
    "our work",
  ]);

  const socialLinks = extractSocialLinksFromHrefs(parsedHome.hrefs);

  const hasContactPage = parsedHome.links.some((l) => l.type === "contact");
  const hasBookingOrQuote = parsedHome.links.some(
    (l) => l.type === "booking" || l.type === "quote"
  );
  const hasPricingPage = parsedHome.links.some((l) => l.type === "pricing");
  const hasServicesPage = parsedHome.links.some((l) => l.type === "services");
  const hasAboutOrTeamPage = parsedHome.links.some((l) => l.type === "about");
  const hasBlogOrNewsPage = parsedHome.links.some((l) => l.type === "blog");
  const hasCareersPage = parsedHome.links.some((l) => l.type === "careers");

  // Signal text excludes site chrome (nav/header/footer/aside), so menu
  // words such as "Careers" or "Leadership" are not read as page claims.
  const pageTexts: PageText[] = [
    {
      url: outcome.finalUrl,
      text: parsedHome.contentText,
      sourceType: "homepage",
      sourceIds: [sourceId],
    },
  ];

  const evidence: EvidenceItem[] = [];
  evidence.push({
    claim: `Homepage fetched successfully in ${outcome.ms}ms.`,
    sourceUrl: outcome.finalUrl,
    sourceType: "homepage",
    sourceIds: [sourceId],
    confidence: "high",
  });

  const linksToFollow = pickInternalLinksToFollow(parsedHome.links, baseHost);
  const linkedPageAttempts: LinkedPageAttempt[] = [];
  let limitedAudit = false;

  for (const link of linksToFollow) {
    const linkedAccessedAt = new Date().toISOString();
    const subOutcome = await safeFetchHtml(link.href, {
      signal: args.signal,
      budgetMs: remainingBudgetMs(deadlineAt),
    });
    if (subOutcome.ok) {
      linkedPageAttempts.push({
        url: subOutcome.finalUrl,
        status: "used",
        accessedAt: linkedAccessedAt,
      });
      const parsedSub = parseHtml(subOutcome.html, subOutcome.finalUrl);
      pageTexts.push({
        url: subOutcome.finalUrl,
        text: parsedSub.contentText,
        sourceType: "linked_page",
        sourceIds: [sourceId],
      });
      evidence.push({
        claim: `Linked page (${link.type}) reviewed for additional public signals.`,
        sourceUrl: subOutcome.finalUrl,
        sourceType: "linked_page",
        sourceIds: [sourceId],
        confidence: "medium",
      });
    } else {
      limitedAudit = true;
      linkedPageAttempts.push({
        url: link.href,
        status: "unavailable",
        reason: subOutcome.reason,
        reasonCode: subOutcome.code,
        accessedAt: linkedAccessedAt,
      });
    }
  }

  const isHttps = outcome.finalUrl.startsWith("https:");

  const scoreBreakdown = computeScoreBreakdown({
    title: parsedHome.title,
    metaDescription: parsedHome.metaDescription,
    h1Count: parsedHome.h1Count,
    wordCount: parsedHome.wordCount,
    businessType,
    market,
    bodyText: parsedHome.bodyText,
    ctaCount,
    hasPhone: parsedHome.hasPhone,
    hasEmail: parsedHome.hasEmail,
    hasContactPage,
    hasBookingOrQuote,
    hasServicesPage,
    hasPricingPage,
    hasTestimonials: testimonialHits > 0,
    hasTrustLanguage: trustLanguageHits > 0,
    hasAboutOrTeamPage,
    hasGalleryOrCaseStudy: galleryHits > 0,
    hasBlogOrNewsPage,
    headingCount: parsedHome.headingCount,
    hasViewport: parsedHome.hasViewport,
    fetchMs: outcome.ms,
    htmlBytes: outcome.bytes,
    isHttps,
  });

  const websiteScore =
    scoreBreakdown.seo +
    scoreBreakdown.conversion +
    scoreBreakdown.trust +
    scoreBreakdown.content +
    scoreBreakdown.technical;

  const audit: WebsiteAudit = {
    url,
    normalizedUrl: outcome.finalUrl,
    auditStatus: limitedAudit ? "partial" : "complete",
    skipped: false,
    reason: limitedAudit ? "some linked pages could not be fetched" : undefined,
    sourceIds: [sourceId],
    title: parsedHome.title,
    metaDescription: parsedHome.metaDescription,
    h1Count: parsedHome.h1Count,
    headingCount: parsedHome.headingCount,
    wordCount: parsedHome.wordCount,
    ctaCount,
    hasPhone: parsedHome.hasPhone,
    hasEmail: parsedHome.hasEmail,
    hasContactPage,
    hasBookingOrQuote,
    hasPricingPage,
    hasServicesPage,
    hasAboutOrTeamPage,
    hasBlogOrNewsPage,
    hasCareersPage,
    hasTestimonials: testimonialHits > 0,
    hasTrustLanguage: trustLanguageHits > 0,
    hasGalleryOrCaseStudy: galleryHits > 0,
    hasSocialLinks: Object.keys(socialLinks).length > 0,
    hasViewport: parsedHome.hasViewport,
    isHttps,
    htmlBytes: outcome.bytes,
    fetchMs: outcome.ms,
    extractedLinks: parsedHome.links.slice(0, 30),
    socialLinks,
    websiteScore,
    scoreBreakdown,
    evidence,
  };

  const result: AuditResult = {
    audit,
    pageTexts,
    linkedPageAttempts,
    accessedAt,
  };
  await writeCache("homepages", cacheKey, result);
  return result;
}
