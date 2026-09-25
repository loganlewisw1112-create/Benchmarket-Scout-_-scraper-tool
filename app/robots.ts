import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

// Shared report pages are public-by-link, not public-by-search: they are also
// marked noindex in their metadata. The API is never meant to be crawled.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/api/", "/r/"],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
