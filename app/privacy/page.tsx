import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy | Benchmark Scout",
  description: "What Benchmark Scout collects, how long it is kept, and how to ask for deletion.",
  alternates: { canonical: "/privacy" },
};

// Keep every retention figure here in sync with the code that enforces it:
// REPORT_TTL_SECONDS and WAITLIST_TTL_SECONDS in lib/store.ts, WINDOW_MS in
// lib/rate-limit.ts, and the <Analytics /> tag in app/layout.tsx.
const privacyPoints = [
  {
    title: "Report inputs are submitted business information.",
    detail:
      "To build a report we process the business name, website, business type, and city or market you enter. Your website is fetched by our server like a normal visit. The market and business type are sent as search queries to the public data sources listed below, and business names are sent to GDELT to look for news mentions.",
  },
  {
    title: "Reports are kept for 90 days and are public by link.",
    detail:
      "Each report, including the inputs above and the public data it cites, is stored for 90 days and then deleted automatically. Anyone who has a report link can open it during that time. Do not submit business information you would not want a link recipient to see.",
  },
  {
    title: "Email and feedback are optional, and kept for up to a year after the last submission.",
    detail:
      "We collect your email address, and any feedback you type, only when you submit the updates and feedback form. We also record which page or report the form was sent from and when. The list expires automatically 365 days after the most recent submission to it; entries are not expired one by one, so ask us if you want yours removed sooner.",
  },
  {
    title: "Your IP address is used briefly for rate limiting.",
    detail:
      "To stop abuse, each request to the analysis, sample, feedback, and report endpoints is counted against your IP address. The counter is stored with your IP address in its key and expires after about a minute. Benchmark Scout's own application logs do not record IP addresses.",
  },
  {
    title: "Our host keeps standard request logs.",
    detail:
      "Like any website, requests pass through Vercel, which records platform request logs (including IP address, URL, and time) and keeps them for the period set by Vercel's own policies and plan limits.",
  },
  {
    title: "We count anonymous page views.",
    detail:
      "Vercel Web Analytics records which pages are visited so we can tell whether people are finding and using the tool. It is cookieless, does not build a profile of you, and does not follow you to other sites.",
  },
  {
    title: "No accounts, and no advertising or email tracking.",
    detail:
      "You can use Benchmark Scout without creating an account, and we do not add advertising or email tracking pixels.",
  },
  {
    title: "The service uses Vercel and Upstash.",
    detail:
      "Benchmark Scout is hosted and processed on Vercel, with persistent report, waitlist, and feedback records stored in Upstash.",
  },
  {
    title: "Report data comes from public sources.",
    detail:
      "Markets are located with OpenStreetMap Nominatim, nearby businesses are found with the OpenStreetMap Overpass API, news mentions come from GDELT, and website signals come from each business's public homepage. Map data © OpenStreetMap contributors, available under the Open Database License.",
  },
  {
    title: "Use the feedback form to contact us or ask for deletion.",
    detail:
      "Questions, corrections, and privacy requests, including asking us to delete your email and feedback or a report you created, can be sent through the updates and feedback form on the home page. Include the email address or report link the request is about.",
  },
];

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-slate-50 px-6 py-12">
      <main className="mx-auto max-w-3xl rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-10">
        <Link
          href="/"
          className="text-sm font-medium text-indigo-700 hover:text-indigo-600"
        >
          &larr; Benchmark Scout
        </Link>
        <h1 className="mt-6 text-3xl font-bold tracking-tight text-slate-900">
          Privacy
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-slate-600">
          Benchmark Scout is a small open beta. This page explains the data it
          handles in plain language.
        </p>

        <ol className="mt-8 space-y-5">
          {privacyPoints.map((point, index) => (
            <li key={point.title} className="flex gap-3">
              <span
                aria-hidden="true"
                className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-xs font-bold text-indigo-700"
              >
                {index + 1}
              </span>
              <div>
                <h2 className="text-sm font-semibold text-slate-900">
                  {point.title}
                </h2>
                <p className="mt-1 text-sm leading-relaxed text-slate-600">
                  {point.detail}
                </p>
              </div>
            </li>
          ))}
        </ol>

        <div className="mt-8 border-t border-slate-200 pt-6">
          <Link
            href="/#feedback"
            className="inline-flex rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-500"
          >
            Open the feedback form
          </Link>
        </div>
      </main>
    </div>
  );
}
