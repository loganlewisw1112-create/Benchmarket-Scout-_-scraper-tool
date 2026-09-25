import Link from "next/link";
import { OSM_ATTRIBUTION, OSM_COPYRIGHT_URL } from "@/lib/site";

// Rendered once by the root layout, so every page (home, shared reports,
// privacy, not-found, maintenance) carries the OpenStreetMap attribution that
// the ODbL and the Nominatim/Overpass usage policies require wherever
// OSM-derived data is shown.
export default function SiteFooter() {
  return (
    <footer className="border-t border-slate-200 bg-white">
      <div className="mx-auto flex max-w-5xl flex-col gap-2 px-6 py-4 text-xs text-slate-600 sm:flex-row sm:items-center sm:justify-between">
        <p>
          <a
            href={OSM_COPYRIGHT_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="underline decoration-slate-400 underline-offset-2 hover:text-slate-900"
          >
            {OSM_ATTRIBUTION}
          </a>
          . OpenStreetMap data is available under the Open Database License.
        </p>
        <nav aria-label="Site" className="flex shrink-0 gap-4">
          <Link
            href="/privacy"
            className="font-medium text-indigo-700 hover:text-indigo-600"
          >
            Privacy
          </Link>
        </nav>
      </div>
    </footer>
  );
}
