import type { Metadata } from "next";
import { OG_IMAGE, SITE_NAME } from "./site";

// Metadata merging across segments is shallow: returning our own `openGraph`
// and `twitter` objects replaces the root layout's, including its file-based
// opengraph-image.png. Re-specify the image so shared links keep a preview.
// The canonical is absolute to the primary domain (root metadataBase), which
// also canonicalizes the page when it is served from a secondary domain.
export function sharedReportMetadata(
  id: string,
  title: string,
  description: string
): Metadata {
  return {
    title,
    description,
    robots: { index: false, follow: false },
    alternates: { canonical: `/r/${encodeURIComponent(id)}` },
    openGraph: {
      title,
      description,
      siteName: SITE_NAME,
      type: "article",
      url: `/r/${encodeURIComponent(id)}`,
      images: [OG_IMAGE],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [OG_IMAGE],
    },
  };
}
