import * as cheerio from "cheerio";
import { CACHE_TTL, readCache, writeCache } from "./cache";
import { isPathAllowed } from "./robots";
import { KEYWORDS, extractSocialLinksFromHrefs } from "./signals";
import type {
  EvidenceItem,
  ExtractedLink,
  SourceId,
  WebsiteAudit,
} from "./types";
import { createPinnedHttpTarget, normalizeHttpUrl } from "./url-safety";
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
const PAGE_FETCH_BUDGET_MS = 5_000;
const MAX_REDIRECTS = 3;

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
  accessedAt: string;
};

export type AuditResult = {
  audit: WebsiteAudit;
  pageTexts: PageText[];
  linkedPageAttempts: LinkedPageAttempt[];
  accessedAt: string;
};

type FetchOutcome =
  | { ok: true; html: string; finalUrl: string; bytes: number; ms: number }
  | { ok: false; reason: string };

async function safeFetchHtml(
  rawUrl: string,
  options: RequestBudgetOptions = {}
): Promise<FetchOutcome> {
  let currentUrl = rawUrl;
  const start = Date.now();
  if (options.signal?.aborted || (options.budgetMs ?? 1) <= 0) {
    return { ok: false, reason: "Audit time budget exhausted" };
  }
  const timed = createTimedSignal(
    options.signal,
    Math.min(PAGE_FETCH_BUDGET_MS, options.budgetMs ?? PAGE_FETCH_BUDGET_MS)
  );

  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (timed.signal.aborted) {
        return { ok: false, reason: "Audit time budget exhausted" };
      }
    let normalized: string;
    try {
      normalized = normalizeHttpUrl(currentUrl);
    } catch {
      return { ok: false, reason: "Invalid URL" };
    }

    let pinnedTarget: Awaited<ReturnType<typeof createPinnedHttpTarget>>;
    try {
      pinnedTarget = await abortable(
        createPinnedHttpTarget(normalized, timed.signal),
        timed.signal
      );
    } catch {
      return { ok: false, reason: "Audit time budget exhausted" };
    }
    if (!pinnedTarget) {
      return { ok: false, reason: "URL failed public safety check" };
    }

    // No-op unless STRICT_ROBOTS=true; covers homepage, linked pages, and
    // every redirect hop since each pass through this loop re-checks.
    let robotsAllowed: boolean;
    try {
      robotsAllowed = await abortable(isPathAllowed(normalized), timed.signal);
    } catch {
      await pinnedTarget.close();
      return { ok: false, reason: "Audit time budget exhausted" };
    }
    if (!robotsAllowed) {
      await pinnedTarget.close();
      return { ok: false, reason: "Disallowed by robots.txt" };
    }

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
          return { ok: false, reason: "Redirect without location header" };
        }
        await res.body?.cancel();
        currentUrl = new URL(location, normalized).toString();
        continue;
      }

      if (!res.ok) {
        return { ok: false, reason: `HTTP ${res.status}` };
      }

      const contentType = res.headers.get("content-type") ?? "";
      if (!contentType.includes("text/html")) {
        return { ok: false, reason: "Non-HTML content type" };
      }

      const contentLength = res.headers.get("content-length");
      if (contentLength && parseInt(contentLength, 10) > MAX_HTML_BYTES) {
        return { ok: false, reason: "Response too large" };
      }

      if (!res.body) {
        const html = await res.text();
        return {
          ok: true,
          html,
          finalUrl: normalized,
          bytes: html.length,
          ms: Date.now() - start,
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

      const html = Buffer.concat(chunks).toString("utf8");
      return {
        ok: true,
        html,
        finalUrl: normalized,
        bytes: received,
        ms: Date.now() - start,
      };
    } catch (err) {
      if (timed.signal.aborted) {
        return { ok: false, reason: "Audit time budget exhausted" };
      }
      const message = err instanceof Error ? err.message : "Fetch failed";
      return { ok: false, reason: message };
    } finally {
      await pinnedTarget.close();
    }
  }

    return { ok: false, reason: "Too many redirects" };
  } finally {
    timed.cleanup();
  }
}

function countKeywordOccurrences(text: string, keywords: readonly string[]): number {
  const lower = text.toLowerCase();
  let count = 0;
  for (const keyword of keywords) {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const matches = lower.match(new RegExp(escaped, "g"));
    count += matches ? matches.length : 0;
  }
  return count;
}

function classifyLink(href: string, label: string): ExtractedLink["type"] {
  const l = `${href} ${label}`.toLowerCase();

  if (/facebook\.com|instagram\.com|linkedin\.com|youtube\.com|twitter\.com|x\.com|tiktok\.com/.test(l))
    return "social";
  if (/contact/.test(l)) return "contact";
  if (/book|schedule|appointment/.test(l)) return "booking";
  if (/quote|estimate/.test(l)) return "quote";
  if (/pricing|packages|plans/.test(l)) return "pricing";
  if (/service/.test(l)) return "services";
  if (/about|team|our-story|who-we-are/.test(l)) return "about";
  if (/blog|news|press/.test(l)) return "blog";
  if (/career|jobs|join-our-team/.test(l)) return "careers";
  return "other";
}

const PHONE_REGEX = /(\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/;
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

function parseHtml(html: string, pageUrl: string) {
  const $ = cheerio.load(html);

  $("script, style, noscript").remove();

  const bodyText = $("body").text().replace(/\s+/g, " ").trim();
  const title = $("title").first().text().trim() || undefined;
  const metaDescription =
    $('meta[name="description"]').attr("content")?.trim() || undefined;
  const h1Count = $("h1").length;
  const headingCount = $("h1, h2, h3, h4, h5, h6").length;
  const wordCount = bodyText ? bodyText.split(/\s+/).length : 0;
  const hasViewport = $('meta[name="viewport"]').length > 0;

  const links: ExtractedLink[] = [];
  const hrefs: string[] = [];

  $("a[href]").each((_, el) => {
    const hrefRaw = $(el).attr("href");
    if (!hrefRaw) return;
    if (hrefRaw.startsWith("mailto:") || hrefRaw.startsWith("tel:")) return;

    let absolute: string;
    try {
      absolute = new URL(hrefRaw, pageUrl).toString();
    } catch {
      return;
    }

    const label = $(el).text().trim().slice(0, 60);
    hrefs.push(absolute);
    links.push({ label, href: absolute, type: classifyLink(absolute, label) });
  });

  const htmlHasTel = /tel:/i.test(html);
  const htmlHasMailto = /mailto:/i.test(html);

  return {
    $,
    bodyText,
    title,
    metaDescription,
    h1Count,
    headingCount,
    wordCount,
    hasViewport,
    links,
    hrefs,
    hasPhone: htmlHasTel || PHONE_REGEX.test(bodyText),
    hasEmail: htmlHasMailto || EMAIL_REGEX.test(bodyText),
  };
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
  accessedAt: string = new Date().toISOString()
): AuditResult {
  return {
    audit: {
      url,
      auditStatus: "unavailable",
      skipped: true,
      reason,
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
      accessedAt
    );
  }

  let normalized: string;
  try {
    normalized = normalizeHttpUrl(url);
  } catch {
    return skippedAudit(url, "invalid URL", [sourceId], accessedAt);
  }

  const cacheKey = `v3:homepage:${normalized}:${businessType.toLowerCase()}:${market.toLowerCase()}`;
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

  const outcome = await safeFetchHtml(normalized, {
    signal: args.signal,
    budgetMs: remainingBudgetMs(deadlineAt),
  });
  if (!outcome.ok) {
    return skippedAudit(normalized, outcome.reason, [sourceId], accessedAt);
  }

  const parsedHome = parseHtml(outcome.html, outcome.finalUrl);
  const baseHost = new URL(outcome.finalUrl).hostname.replace(/^www\./, "");

  const ctaCount = countKeywordOccurrences(parsedHome.bodyText, KEYWORDS.cta);
  const testimonialHits = countKeywordOccurrences(parsedHome.bodyText, [
    "testimonial",
    "testimonials",
    "review",
    "reviews",
    "case study",
    "results",
  ]);
  const trustLanguageHits = countKeywordOccurrences(parsedHome.bodyText, [
    "certified",
    "licensed",
    "insured",
    "award",
    "guaranteed",
    "trusted",
  ]);
  const galleryHits = countKeywordOccurrences(parsedHome.bodyText, [
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

  const pageTexts: PageText[] = [
    {
      url: outcome.finalUrl,
      text: parsedHome.bodyText,
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
        text: parsedSub.bodyText,
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
