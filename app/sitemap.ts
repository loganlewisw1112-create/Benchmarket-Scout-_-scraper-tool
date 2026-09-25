import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

// Only the indexable pages. Shared reports (/r/<id>) are noindex and
// disallowed in robots.txt, so they are deliberately absent.
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: `${SITE_URL}/`, changeFrequency: "monthly", priority: 1 },
    { url: `${SITE_URL}/privacy`, changeFrequency: "yearly", priority: 0.3 },
  ];
}
