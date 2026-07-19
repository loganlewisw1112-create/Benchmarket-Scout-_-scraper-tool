"use client";

import Link from "next/link";
import { useState, useSyncExternalStore } from "react";
import BusinessForm from "@/components/BusinessForm";
import LoadingSteps from "@/components/LoadingSteps";
import ResultsDashboard from "@/components/ResultsDashboard";
import ShareReport from "@/components/ShareReport";
import WaitlistForm from "@/components/WaitlistForm";
import {
  getAccessKey,
  jsonHeaders,
  setAccessKey,
  subscribeAccessKey,
} from "@/lib/scout-client";
import type { AnalyzeMarketRequest, AnalyzeMarketResponse } from "@/lib/types";

type ViewState = "form" | "loading" | "results" | "error";

export default function HomePage({
  keyGateEnabled,
}: {
  keyGateEnabled: boolean;
}) {
  const [viewState, setViewState] = useState<ViewState>("form");
  const [result, setResult] = useState<AnalyzeMarketResponse | null>(null);
  const [currentSampleId, setCurrentSampleId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(false);
  const accessKey = useSyncExternalStore(
    subscribeAccessKey,
    getAccessKey,
    () => ""
  );

  function saveKey(value: string) {
    setAccessKey(value);
  }

  async function handleSubmit(payload: AnalyzeMarketRequest) {
    setViewState("loading");
    setErrorMessage(null);

    try {
      const res = await fetch("/api/analyze-market", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify(payload),
      });

      const json = await res.json();

      if (!res.ok) {
        if (res.status === 401) setShowKey(true);
        setErrorMessage(
          json?.error ??
            "Analysis failed. Please check your input and try again."
        );
        setViewState("error");
        return;
      }

      setResult(json as AnalyzeMarketResponse);
      setCurrentSampleId(null);
      setViewState("results");
    } catch {
      setErrorMessage("Could not reach the analysis service. Please try again.");
      setViewState("error");
    }
  }

  async function handleSampleReport() {
    setViewState("loading");
    setErrorMessage(null);

    try {
      const query = currentSampleId
        ? `?exclude=${encodeURIComponent(currentSampleId)}`
        : "";
      const res = await fetch(`/api/sample-report${query}`, {
        headers: jsonHeaders(),
      });
      const json = await res.json();

      if (!res.ok) {
        if (res.status === 401) setShowKey(true);
        setErrorMessage(
          json?.error ?? "Could not load a real sample report. Please try again."
        );
        setViewState("error");
        return;
      }

      if (!json?.report || typeof json?.sampleId !== "string") {
        setErrorMessage("The real sample response was incomplete. Please try again.");
        setViewState("error");
        return;
      }

      setResult({
        ...(json.report as AnalyzeMarketResponse),
        reportId: json.reportId ?? json.report.reportId,
      });
      setCurrentSampleId(json.sampleId);
      setViewState("results");
    } catch {
      setErrorMessage(
        "Could not reach the real sample service. Please try again."
      );
      setViewState("error");
    }
  }

  function reset() {
    setResult(null);
    setErrorMessage(null);
    setViewState("form");
  }

  const showIntro = viewState !== "results";

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-5">
          <div className="flex items-center gap-2">
            <span className="text-lg font-bold tracking-tight text-slate-900">
              Benchmark Scout
            </span>
            <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-[11px] font-semibold text-indigo-700">
              beta
            </span>
          </div>
          <div className="flex items-center gap-4">
            {viewState === "results" ? (
              <button
                type="button"
                onClick={reset}
                className="text-sm font-medium text-indigo-600 hover:text-indigo-500"
              >
                &larr; Run another report
              </button>
            ) : null}
            {keyGateEnabled ? (
              <button
                type="button"
                onClick={() => setShowKey((visible) => !visible)}
                className="text-sm font-medium text-slate-500 hover:text-slate-700"
              >
                {accessKey ? "Access code set" : "Access code"}
              </button>
            ) : null}
          </div>
        </div>
        {keyGateEnabled && showKey ? (
          <div className="border-t border-slate-100 bg-slate-50 px-6 py-4">
            <div className="mx-auto flex max-w-5xl flex-col gap-2 sm:flex-row sm:items-center">
              <input
                type="text"
                value={accessKey}
                onChange={(event) => saveKey(event.target.value)}
                placeholder="Paste your beta access code"
                className="flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
              <button
                type="button"
                onClick={() => setShowKey(false)}
                className="rounded-lg bg-slate-800 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-700"
              >
                Done
              </button>
            </div>
            <p className="mx-auto mt-1 max-w-5xl text-xs text-slate-500">
              This beta is gated. Paste the shared code you were given; it stays
              on this device only.
            </p>
          </div>
        ) : null}
      </header>

      <main className="mx-auto max-w-5xl space-y-8 px-6 py-10">
        {showIntro ? (
          <section className="grid grid-cols-1 gap-8 lg:grid-cols-2 lg:items-center">
            <div>
              <h1 className="text-4xl font-bold tracking-tight text-slate-900">
                See where your business really stands locally.
              </h1>
              <p className="mt-4 text-base leading-relaxed text-slate-600">
                Benchmark Scout finds your local competitors from public web
                data, audits their websites for SEO, conversion, trust, and
                content signals, scans for momentum and risk, and shows you the
                gaps you can close, all in a single report.
              </p>
              <ul className="mt-5 space-y-2 text-sm text-slate-600">
                <li className="flex gap-2">
                  <span className="font-semibold text-indigo-600">&#10003;</span>{" "}
                  No login, no scraping of private data. Public signals only.
                </li>
                <li className="flex gap-2">
                  <span className="font-semibold text-indigo-600">&#10003;</span>{" "}
                  Evidence-backed findings you can act on today.
                </li>
                <li className="flex gap-2">
                  <span className="font-semibold text-indigo-600">&#10003;</span>{" "}
                  Export to PDF and share a link.
                </li>
              </ul>
              <div className="mt-6 flex flex-wrap gap-3">
                <a
                  href="#run"
                  className="rounded-lg bg-indigo-600 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-500"
                >
                  Run your report
                </a>
                <button
                  type="button"
                  onClick={handleSampleReport}
                  disabled={viewState === "loading"}
                  className="rounded-lg border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-60"
                >
                  See a real sample report
                </button>
              </div>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                What you get
              </p>
              <div className="mt-3 space-y-3 text-sm text-slate-600">
                <p className="rounded-lg bg-slate-50 px-3 py-2">
                  <span className="font-semibold text-slate-900">
                    Market position
                  </span>{" "}
                  &mdash; your rank vs. nearby competitors and the size of the
                  gap.
                </p>
                <p className="rounded-lg bg-slate-50 px-3 py-2">
                  <span className="font-semibold text-slate-900">
                    Website audit
                  </span>{" "}
                  &mdash; SEO, conversion, trust, content, and technical scores
                  with evidence.
                </p>
                <p className="rounded-lg bg-slate-50 px-3 py-2">
                  <span className="font-semibold text-slate-900">
                    Action plan
                  </span>{" "}
                  &mdash; prioritized recommendations, not a wall of raw data.
                </p>
              </div>
            </div>
          </section>
        ) : null}

        <div id="run" className="scroll-mt-6 space-y-8">
          {viewState !== "results" ? (
            <BusinessForm
              onSubmit={handleSubmit}
              isLoading={viewState === "loading"}
            />
          ) : null}

          {viewState === "loading" ? <LoadingSteps /> : null}

          {viewState === "error" && errorMessage ? (
            <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
              {errorMessage}
            </div>
          ) : null}

          {viewState === "results" && result ? (
            <div className="space-y-6">
              <ShareReport reportId={result.reportId} />
              <ResultsDashboard data={result} />
            </div>
          ) : null}
        </div>

        <section id="feedback" className="scroll-mt-6">
          <WaitlistForm
            source={viewState === "results" ? "report" : "landing"}
            reportId={result?.reportId}
          />
        </section>

        <footer className="border-t border-slate-200 pt-6 text-xs leading-relaxed text-slate-500">
          <p className="font-medium text-slate-600">How this works</p>
          <p className="mt-1 max-w-3xl">
            Benchmark Scout geocodes your market with Nominatim, discovers
            nearby businesses from OpenStreetMap/Overpass, audits public
            homepages for SEO/conversion/trust/content/technical signals, scans
            for public momentum, risk, offer, and hiring language, and checks
            GDELT for public news mentions. Sparse or unavailable evidence is
            shown honestly as N/A; it is never filled with simulated data.
            Every report includes its source appendix. Nothing here accesses
            private accounts, bypasses logins, or scrapes paywalled or
            CAPTCHA-protected content.
          </p>
          <p className="mt-4 flex flex-wrap gap-x-4 gap-y-2">
            <a
              href="#feedback"
              className="font-medium text-indigo-700 hover:text-indigo-600"
            >
              Contact or send feedback
            </a>
            <Link
              href="/privacy"
              className="font-medium text-indigo-700 hover:text-indigo-600"
            >
              Privacy
            </Link>
          </p>
        </footer>
      </main>
    </div>
  );
}
