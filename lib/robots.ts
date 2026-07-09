import { CACHE_TTL, readCache, writeCache } from "./cache";
import { isSafePublicHttpUrl, normalizeHttpUrl } from "./url-safety";

// robots.txt compliance for website audits, gated by STRICT_ROBOTS=true.
// Follows RFC 9309 semantics for the common cases: user-agent group
// selection (most specific token, falling back to "*"), longest-match rule
// precedence with Allow winning ties, `*` wildcards, and `$` end anchors.
// Fails open: an unreachable or malformed robots.txt never blocks an audit.

const USER_AGENT =
  process.env.APP_USER_AGENT ??
  "BenchmarkScout/0.1 (contact: loganlewisw1112@gmail.com)";

const USER_AGENT_TOKEN = "benchmarkscout";
const ROBOTS_FETCH_TIMEOUT_MS = 5000;
const MAX_REDIRECTS = 3;
const MAX_ROBOTS_BYTES = 512 * 1024;

export type RobotsRule = { allow: boolean; path: string };

type RobotsGroup = { agents: string[]; rules: RobotsRule[] };

// Cached wrapper distinguishes "robots.txt unavailable" (fail-open) from a
// cache miss, so unavailable origins are not re-fetched on every audit.
type CachedRobots = { fetched: boolean; content: string };

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
      if (current && value) {
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
  let bestRules: RobotsRule[] | null = null;
  let bestAgentLength = -1;

  for (const group of parseGroups(content)) {
    for (const agent of group.agents) {
      if (agent === "*") {
        starRules = [...(starRules ?? []), ...group.rules];
      } else if (token.includes(agent) && agent.length > bestAgentLength) {
        bestAgentLength = agent.length;
        bestRules = group.rules;
      }
    }
  }

  return bestRules ?? starRules ?? [];
}

function ruleToRegex(rulePath: string): RegExp {
  let pattern = rulePath;
  const anchored = pattern.endsWith("$");
  if (anchored) pattern = pattern.slice(0, -1);

  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");

  return new RegExp(`^${escaped}${anchored ? "$" : ""}`);
}

export function isPathAllowedByRules(
  rules: RobotsRule[],
  path: string
): boolean {
  let best: { rule: RobotsRule; length: number } | null = null;

  for (const rule of rules) {
    if (!ruleToRegex(rule.path).test(path)) continue;

    const length = rule.path.length;
    const wins =
      !best ||
      length > best.length ||
      (length === best.length && rule.allow && !best.rule.allow);

    if (wins) best = { rule, length };
  }

  return best ? best.rule.allow : true;
}

async function fetchRobotsTxt(startUrl: string): Promise<CachedRobots> {
  let currentUrl = startUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    // Re-validate every hop, mirroring safeFetchHtml's redirect handling.
    const safe = await isSafePublicHttpUrl(currentUrl);
    if (!safe) return { fetched: false, content: "" };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ROBOTS_FETCH_TIMEOUT_MS);

    try {
      const res = await fetch(currentUrl, {
        headers: { "User-Agent": USER_AGENT, Accept: "text/plain" },
        redirect: "manual",
        signal: controller.signal,
      });

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location) return { fetched: false, content: "" };
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }

      // 404/other errors: treat as "no restrictions published" (fail-open).
      if (!res.ok) return { fetched: false, content: "" };

      const text = await res.text();
      return { fetched: true, content: text.slice(0, MAX_ROBOTS_BYTES) };
    } catch {
      return { fetched: false, content: "" };
    } finally {
      clearTimeout(timeout);
    }
  }

  return { fetched: false, content: "" };
}

export async function isPathAllowed(targetUrl: string): Promise<boolean> {
  if (process.env.STRICT_ROBOTS !== "true") return true;

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
    robots = await fetchRobotsTxt(`${url.origin}/robots.txt`);
    await writeCache("robots", cacheKey, robots);
  }

  if (!robots.fetched) return true;

  const rules = selectRules(robots.content);
  return isPathAllowedByRules(rules, url.pathname + url.search);
}
