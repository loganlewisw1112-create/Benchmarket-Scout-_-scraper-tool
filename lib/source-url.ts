// Readable display text for cited source URLs, shared by the on-screen
// Sources Appendix (components/ProvenanceDetails.tsx) and the PDF export
// (lib/pdf.ts), so both show the same thing (frontend-3).

const MAX_DISPLAY_PATH = 72;

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}

/** True for the bare Overpass API endpoint, which is only queried by POST. */
export function isPostOnlyOverpassEndpoint(parsed: URL): boolean {
  return /\/api\/interpreter\/?$/.test(parsed.pathname) && !parsed.search;
}

/**
 * Readable parts of a source URL for display: the domain, plus a decoded,
 * shortened path and query (whitespace collapsed, so a multi-line Overpass
 * query stays on one line). The full URL stays in the link's href/title.
 * Overpass is queried with a POST body, so its bare interpreter endpoint is
 * not a reproducible link and is shown as plain text.
 */
export function describeSourceUrl(url: string): {
  domain: string;
  detail: string;
  linkable: boolean;
} {
  const parsed = new URL(url);
  const domain = parsed.hostname.replace(/^www\./, "");
  if (isPostOnlyOverpassEndpoint(parsed)) {
    return {
      domain,
      detail: "Overpass query sent as a POST request; no direct link",
      linkable: false,
    };
  }
  const path = safeDecode(`${parsed.pathname}${parsed.search}`)
    .replace(/\s+/g, " ")
    .trim();
  const detail =
    path === "/"
      ? ""
      : path.length > MAX_DISPLAY_PATH
        ? `${path.slice(0, MAX_DISPLAY_PATH - 1)}…`
        : path;
  return { domain, detail, linkable: true };
}
