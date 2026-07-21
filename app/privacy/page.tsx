import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy | Benchmark Scout",
  description: "What Benchmark Scout collects and how submitted data is used.",
};

const privacyPoints = [
  {
    title: "Email is optional to share with us.",
    detail:
      "We collect your email address only when you choose to submit the updates or feedback form.",
  },
  {
    title: "Report inputs are submitted business information.",
    detail:
      "We process the business name, website, business type, and city or market you enter to build a report.",
  },
  {
    title: "No accounts, and no advertising or email tracking.",
    detail:
      "You can use Benchmark Scout without creating an account, and we do not add advertising or email tracking pixels.",
  },
  {
    title: "We count anonymous page views.",
    detail:
      "Vercel Web Analytics records which pages are visited so we can tell whether people are finding and using the tool. It is cookieless, does not build a profile of you, and does not follow you to other sites.",
  },
  {
    title: "The service uses Vercel and Upstash.",
    detail:
      "Benchmark Scout is hosted and processed on Vercel, with persistent report, waitlist, and feedback records stored in Upstash.",
  },
  {
    title: "Shared report links are public by URL.",
    detail:
      "Anyone who has a report link can open it. Do not submit business information you would not want a link recipient to see.",
  },
  {
    title: "Use the feedback form to contact us.",
    detail:
      "Questions, corrections, and privacy requests can be sent through the updates and feedback form on the home page.",
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
