// Site-wide identity shared by metadata, robots.txt, and sitemap.xml.

export const SITE_NAME = "Benchmark Scout";
export const SITE_DESCRIPTION =
  "Local competitor intelligence from public web signals.";

const DEFAULT_SITE_URL = "https://benchmark-scout.vercel.app";

// Canonical public origin. Every deployment (including the second Vercel
// project's domain) builds absolute canonical, Open Graph, robots, and sitemap
// URLs from this value, so duplicate hosts point search engines and link
// previews back at the primary domain. Without it Next would fall back to
// VERCEL_URL, the per-deployment hostname.
export function resolveSiteUrl(
  raw: string | undefined = process.env.NEXT_PUBLIC_SITE_URL
): string {
  const value = raw?.trim();
  if (!value) return DEFAULT_SITE_URL;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return DEFAULT_SITE_URL;
    }
    return url.origin;
  } catch {
    return DEFAULT_SITE_URL;
  }
}

export const SITE_URL = resolveSiteUrl();

// The root segment's file-based image (app/opengraph-image.png). Metadata
// merging is shallow, so any segment that sets its own `openGraph` or
// `twitter` object must re-specify this image or the preview loses it.
export const OG_IMAGE = {
  url: "/opengraph-image.png",
  width: 1200,
  height: 630,
  alt: "Benchmark Scout — see where your business really stands locally. Local competitor intelligence from public web signals.",
} as const;

export const OSM_COPYRIGHT_URL = "https://www.openstreetmap.org/copyright";
export const OSM_ATTRIBUTION = "Map data © OpenStreetMap contributors";
