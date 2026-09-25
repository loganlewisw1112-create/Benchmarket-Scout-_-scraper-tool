import { CACHE_TTL, readCache, writeCache } from "./cache";
import { createPinnedHttpTarget, normalizeHttpUrl } from "./url-safety";
import type { Dispatcher } from "undici";

// robots.txt compliance for website audits, gated by STRICT_ROBOTS=true.
// Follows RFC 9309 semantics for the common cases: user-agent group
// selection (exact, case-insensitive product-token match, with every group
// naming that token merged, falling back to the merged "*" groups),
// longest-match rule precedence with Allow winning ties, `*` wildcards, and
// `$` end anchors. Fails open when robots.txt is missing (4xx), unreachable
// (network error or timeout) or malformed. A 5xx answer means the site
// published rules it cannot serve right now, so, per RFC 9309 section
// 2.3.1.4, the path is treated as disallowed; that answer is not cached.
//
// Both the robots.txt body and the audited path are controlled by the target
// site, so matching is linear-time (no regex) and every input is bounded.

const USER_AGENT =
  process.env.APP_USER_AGENT ??
  "BenchmarkScout/0.1 (contact: github.com/loganlewisw1112-create/Benchmarket-Scout-_-scraper-tool)";

const USER_AGENT_TOKEN = "benchmarkscout";
const ROBOTS_FETCH_TIMEOUT_MS = 5000;
const MAX_REDIRECTS = 3;
const MAX_ROBOTS_BYTES = 512 * 1024;

// Bounds on attacker-controlled input. Rules over these limits are ignored
// (fail-open, consistent with the rest of this module); paths are truncated.
export const MAX_RULES_PER_GROUP = 500;
export const MAX_RULE_LENGTH = 512;
export const MAX_WILDCARDS_PER_RULE = 16;
export const MAX_PATH_LENGTH = 2048;

export type RobotsRule = { allow: boolean; path: string };

type RobotsGroup = { agents: string[]; rules: RobotsRule[] };

// Cached wrapper distinguishes "robots.txt unavailable" (fail-open) from a
// cache miss, so unavailable origins are not re-fetched on every audit.
type CachedRobots = {
  fetched: boolean;
  content: string;
  /** robots.txt answered 5xx: complete disallow, never cached. */
  serverError?: boolean;
};

function isBoundedRule(rulePath: string): boolean {
  if (rulePath.length > MAX_RULE_LENGTH) return false;
  let wildcards = 0;
  for (let i = 0; i < rulePath.length; i++) {
    if (rulePath[i] === "*" && ++wildcards > MAX_WILDCARDS_PER_RULE) {
      return false;
    }
  }
  return true;
}

function parseGroups(content: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let lastLineWasAgent = false;

  for (const rawLine of content.split(/\r?\n/)) {
    const withoutComment = rawLine.split("#")[0];
    const line = withoutComment.trim();
    if (!line) continue;

    const separator = line.indexOf(":");
    if (separator < 0) continue;

    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === "user-agent") {
      if (lastLineWasAgent && current) {
        current.agents.push(value.toLowerCase());
      } else {
        current = { agents: [value.toLowerCase()], rules: [] };
        groups.push(current);
      }
      lastLineWasAgent = true;
    } else if (field === "allow" || field === "disallow") {
      lastLineWasAgent = false;
      // An empty Disallow/Allow value is a no-op ("allow everything").
      if (
        current &&
        value &&
        current.rules.length < MAX_RULES_PER_GROUP &&
        isBoundedRule(value)
      ) {
        current.rules.push({ allow: field === "allow", path: value });
      }
    } else {
      // sitemap, crawl-delay, etc. — ignored, but they end an agent run.
      lastLineWasAgent = false;
    }
  }

  return groups;
}

export function selectRules(
  content: string,
  userAgentToken: string = USER_AGENT_TOKEN
): RobotsRule[] {
  const token = userAgentToken.toLowerCase();

  let starRules: RobotsRule[] | null = null;
  let tokenRules: RobotsRule[] | null = null;

  // Groups naming the same agent merge (RFC 9309 section 2.2.1); the merged
  // set stays within the same per-group cap. Only an exact product-token
  // match binds, so a group for e.g. "scout" never applies to us.
  for (const group of parseGroups(content)) {
    if (group.agents.includes(token)) {
      tokenRules = [...(tokenRules ?? []), ...group.rules].slice(
        0,
        MAX_RULES_PER_GROUP
      );
    } else if (group.agents.includes("*")) {
      starRules = [...(starRules ?? []), ...group.rules].slice(
        0,
        MAX_RULES_PER_GROUP
      );
    }
  }

  return tokenRules ?? starRules ?? [];
}

// Knuth-Morris-Pratt search: first index >= `from` where `needle` occurs in
// `haystack`, or -1. Linear in haystack + needle, unlike a backtracking regex.
function indexOfLinear(haystack: string, needle: string, from: number): number {
  if (needle.length === 0) return from <= haystack.length ? from : -1;

  const failure = new Array<number>(needle.length).fill(0);
  for (let i = 1, k = 0; i < needle.length; i++) {
    while (k > 0 && needle[i] !== needle[k]) k = failure[k - 1];
    if (needle[i] === needle[k]) k++;
    failure[i] = k;
  }

  for (let i = from, k = 0; i < haystack.length; i++) {
    while (k > 0 && haystack[i] !== needle[k]) k = failure[k - 1];
    if (haystack[i] === needle[k]) k++;
    if (k === needle.length) return i - needle.length + 1;
  }
  return -1;
}

// Matches one robots.txt rule against a path: a prefix match where `*` is any
// run of characters and a trailing `$` anchors the end. With `*` as the only
// metacharacter, taking the earliest occurrence of each literal segment is
// optimal, and each search resumes where the previous segment ended, so a
// whole match costs O(path + rule) with no backtracking.
export function ruleMatchesPath(rulePath: string, path: string): boolean {
  const anchored = rulePath.endsWith("$");
  const pattern = anchored ? rulePath.slice(0, -1) : rulePath;
  const segments = pattern.split("*");

  const first = segments[0];
  if (!path.startsWith(first)) return false;
  if (segments.length === 1) {
    return anchored ? path.length === first.length : true;
  }

  let position = first.length;
  const lastIndex = segments.length - 1;
  for (let i = 1; i < lastIndex; i++) {
    const found = indexOfLinear(path, segments[i], position);
    if (found < 0) return false;
    position = found + segments[i].length;
  }

  const last = segments[lastIndex];
  if (anchored) {
    // The final segment must end the path without overlapping earlier ones.
    return path.length - last.length >= position && path.endsWith(last);
  }
  return indexOfLinear(path, last, position) >= 0;
}

export function isPathAllowedByRules(
  rules: RobotsRule[],
  path: string
): boolean {
  const boundedPath = path.slice(0, MAX_PATH_LENGTH);
  let best: { rule: RobotsRule; length: number } | null = null;

  for (const rule of rules.slice(0, MAX_RULES_PER_GROUP)) {
    if (!isBoundedRule(rule.path)) continue;
    if (!ruleMatchesPath(rule.path, boundedPath)) continue;

    const length = rule.path.length;
    const wins =
      !best ||
      length > best.length ||
      (length === best.length && rule.allow && !best.rule.allow);

    if (wins) best = { rule, length };
  }

  return best ? best.rule.allow : true;
}

// Reads at most `maxBytes` of the body and cancels the stream past the cap,
// so an oversized or endless robots.txt is never buffered in full.
async function readCappedText(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  try {
    while (received < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - received;
      const chunk =
        value.byteLength > remaining ? value.subarray(0, remaining) : value;
      chunks.push(chunk);
      received += chunk.byteLength;
    }
    if (received >= maxBytes) await reader.cancel().catch(() => {});
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8").decode(bytes);
}

async function fetchRobotsTxt(
  startUrl: string,
  signal?: AbortSignal
): Promise<CachedRobots> {
  let currentUrl = startUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    // The caller's abort signal (audit time budget) and our own per-hop
    // timeout both cut the lookup short.
    const timeout = AbortSignal.timeout(ROBOTS_FETCH_TIMEOUT_MS);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;

    // Re-resolve, validate, and pin every redirect hop. The request connector
    // cannot perform a second DNS lookup after this safety decision.
    const pinnedTarget = await createPinnedHttpTarget(currentUrl, requestSignal);
    if (!pinnedTarget) return { fetched: false, content: "" };

    try {
      const res = await fetch(pinnedTarget.url, {
        headers: { "User-Agent": USER_AGENT, Accept: "text/plain" },
        redirect: "manual",
        signal: requestSignal,
        dispatcher: pinnedTarget.dispatcher,
      } as RequestInit & { dispatcher: Dispatcher });

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        await res.body?.cancel();
        if (!location) return { fetched: false, content: "" };
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }

      // 5xx: the rules exist but are unavailable, so disallow (RFC 9309).
      if (res.status >= 500) {
        await res.body?.cancel();
        return { fetched: false, content: "", serverError: true };
      }

      // 404/other 4xx: treat as "no restrictions published" (fail-open).
      if (!res.ok) {
        await res.body?.cancel();
        return { fetched: false, content: "" };
      }

      return {
        fetched: true,
        content: await readCappedText(res, MAX_ROBOTS_BYTES),
      };
    } catch {
      return { fetched: false, content: "" };
    } finally {
      await pinnedTarget.close();
    }
  }

  return { fetched: false, content: "" };
}

/** Whether audits in this process check robots.txt (STRICT_ROBOTS=true). */
export function isRobotsPolicyEnforced(): boolean {
  return process.env.STRICT_ROBOTS === "true";
}

// `signal` is the caller's abort signal (e.g. the audit's time budget). A
// lookup cut short by it is not cached, so an aborted fetch cannot suppress
// an origin's robots.txt for the whole cache TTL.
export async function isPathAllowed(
  targetUrl: string,
  signal?: AbortSignal
): Promise<boolean> {
  if (!isRobotsPolicyEnforced()) return true;

  let url: URL;
  try {
    url = new URL(normalizeHttpUrl(targetUrl));
  } catch {
    // Malformed target: downstream safety checks reject it anyway.
    return true;
  }

  const cacheKey = `robots:${url.origin}`;
  let robots = await readCache<CachedRobots>(
    "robots",
    cacheKey,
    CACHE_TTL.robots
  );

  if (!robots) {
    robots = await fetchRobotsTxt(`${url.origin}/robots.txt`, signal);
    if (signal?.aborted) return true;
    // A server error is transient: disallow this lookup without caching it.
    if (robots.serverError) return false;
    await writeCache("robots", cacheKey, robots);
  }

  if (!robots.fetched) return true;

  const rules = selectRules(robots.content);
  return isPathAllowedByRules(rules, url.pathname + url.search);
}
