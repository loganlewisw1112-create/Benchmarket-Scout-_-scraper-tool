// Browser-side helpers that turn API responses into messages people can act
// on. Every API error body follows `{ code, error, ...extras }`; the UI keys
// its copy on `code` and only falls back to the server's `error` text (or a
// generic line) for codes it does not know. A failed fetch (no response at
// all) is reported differently from a server that answered with an error.

export const NETWORK_ERROR_MESSAGE =
  "Could not reach Benchmark Scout. Check your internet connection and try again.";

export type ApiErrorContext = "analyze" | "sample" | "waitlist";

type ApiErrorBody = { code?: unknown; error?: unknown; reason?: unknown };

// USER_SITE_UNAVAILABLE reasons that point at the address itself. Other
// reasons (a slow or bot-blocked site) say nothing about the address.
const ADDRESS_PROBLEM_REASONS = new Set(["dns_unresolved", "dns_error", "blocked_url"]);

function asBody(body: unknown): ApiErrorBody {
  return body && typeof body === "object" ? (body as ApiErrorBody) : {};
}

function retryable(body: ApiErrorBody): boolean {
  return (body as { retryable?: unknown }).retryable === true;
}

function serverText(body: ApiErrorBody): string | null {
  return typeof body.error === "string" && body.error.trim()
    ? body.error.trim()
    : null;
}

/** Parses a response body as JSON; null when it is empty or not JSON. */
export async function readJsonBody(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** "30 seconds", "1 minute", "3 minutes"; null when the value is unusable. */
export function formatRetryAfter(header: string | null): string | null {
  if (!header) return null;
  const seconds = Number(header.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  if (seconds < 60) {
    const s = Math.ceil(seconds);
    return s === 1 ? "1 second" : `${s} seconds`;
  }
  const minutes = Math.ceil(seconds / 60);
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

/**
 * Message for a non-2xx API response. `retryAfter` is the raw Retry-After
 * header, when the server sent one.
 */
export function describeApiError(
  status: number,
  rawBody: unknown,
  retryAfter: string | null,
  context: ApiErrorContext = "analyze"
): string {
  const body = asBody(rawBody);
  const code = typeof body.code === "string" ? body.code : null;
  const text = serverText(body);
  const wait = formatRetryAfter(retryAfter);

  switch (code) {
    // Pipeline outcomes: the server message names the specific place, type,
    // or site involved, so it is preferred when present.
    case "AMBIGUOUS_MARKET":
      return (
        text ??
        'That city or market matches more than one place. Add the state or country, for example "Portland, OR".'
      );
    case "MARKET_NOT_FOUND":
      return text
        ? `${text} Check the spelling of the city or market, or add the state or country.`
        : "We could not find that city or market. Check the spelling, or add the state or country.";
    case "INDUSTRY_NOT_RESOLVED":
      return (
        text ??
        'We could not match that business type to a category of local businesses. Try a more common name, for example "dentist" or "plumber".'
      );
    case "NO_COMPETITORS_FOUND":
      return (
        text ??
        "No nearby businesses of that type are listed in OpenStreetMap, so there is nothing to compare against. No report was saved."
      );
    case "USER_SITE_UNAVAILABLE": {
      if (!text) {
        return "We could not load your website. Check the address and that the site is online, then try again.";
      }
      const reason = typeof body.reason === "string" ? body.reason : null;
      // Older responses carry no reason: keep the general hint for them.
      if (reason === null || ADDRESS_PROBLEM_REASONS.has(reason)) {
        return `${text} Check the website address and that the site is online.`;
      }
      return retryable(body) ? `${text} Please try again in a few minutes.` : text;
    }
    case "INSUFFICIENT_REAL_DATA":
      return (
        text ??
        "There was not enough public data to build an honest report for this business and market. No report was saved."
      );
    case "SOURCE_UNAVAILABLE":
    case "ANALYSIS_TIMEOUT":
      return "A public data source we rely on is busy or unavailable right now. Nothing is wrong with your input; please try again in a few minutes.";
    case "RATE_LIMITED":
      return wait
        ? `Too many requests right now. Please try again in ${wait}.`
        : "Too many requests right now. Please wait a minute and try again.";
    case "RATE_LIMIT_UNAVAILABLE":
      return "The service is briefly unable to accept new analyses. Please try again in a minute.";
    case "UNSUPPORTED_MEDIA_TYPE":
    case "CROSS_SITE_REQUEST":
      return "Your browser sent the request in a way this site does not accept. Reload the page and try again.";
    case "ACCESS_CODE_REQUIRED":
      return text ?? "This beta requires an access code. Enter yours to continue.";
    case "INVALID_REQUEST":
      return text ?? "Some of the details are not valid. Check each field and try again.";
    case "REAL_SAMPLE_UNAVAILABLE":
      return "No verified sample report is available right now. Please try again later, or run your own report.";
    case "MAINTENANCE":
      return text ?? "Benchmark Scout is paused for maintenance. Please try again later.";
  }

  if (status >= 500) {
    return context === "sample"
      ? "The sample service had a problem on our side. Please try again in a moment."
      : "Benchmark Scout had a problem on our side. Please try again in a moment.";
  }
  if (text) return text;
  return context === "sample"
    ? "Could not load a real sample report. Please try again."
    : "The request could not be completed. Please check your input and try again.";
}

export type WebsiteUrlResult =
  | { ok: true; url: string }
  | { ok: false; message: string };

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const LABEL_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/i;

/**
 * Client-side shape check for the business website field. Accepts bare
 * domains ("acme.com", "www.acme.com/about") by adding https://. The server
 * repeats its own validation and the SSRF checks; this only catches typos
 * before a slow round trip.
 */
export function normalizeWebsiteUrl(raw: string): WebsiteUrlResult {
  const value = raw.trim();
  const invalid = {
    ok: false as const,
    message:
      'Enter your website address, for example "example.com" or "https://example.com".',
  };
  if (!value || /\s/.test(value)) return invalid;

  const hasScheme = SCHEME_RE.test(value) && !/^[^:/]+:\d/.test(value);
  const candidate = hasScheme ? value : `https://${value.replace(/^\/+/, "")}`;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return invalid;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return {
      ok: false,
      message: "Use a website address that starts with http:// or https://.",
    };
  }
  if (url.username || url.password) return invalid;

  const hostname = url.hostname.replace(/\.$/, "");
  const labels = hostname.split(".");
  if (labels.length < 2 || !labels.every((label) => LABEL_RE.test(label))) {
    return invalid;
  }
  const tld = labels[labels.length - 1];
  // A TLD is letters (or an xn-- IDN label); an all-numeric final label is an
  // IPv4 address, which is left for the server to judge.
  if (!/^[a-z]{2,63}$/i.test(tld) && !/^xn--/i.test(tld) && !/^\d+$/.test(tld)) {
    return invalid;
  }

  return { ok: true, url: hasScheme ? value : candidate };
}
