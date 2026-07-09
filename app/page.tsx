"use client";

import { useState } from "react";
import BusinessForm from "@/components/BusinessForm";
import LoadingSteps from "@/components/LoadingSteps";
import ResultsDashboard from "@/components/ResultsDashboard";
import type { AnalyzeMarketRequest, AnalyzeMarketResponse } from "@/lib/types";

type ViewState = "form" | "loading" | "results" | "error";

export default function Home() {
  const [viewState, setViewState] = useState<ViewState>("form");
  const [result, setResult] = useState<AnalyzeMarketResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleSubmit(payload: AnalyzeMarketRequest) {
    setViewState("loading");
    setErrorMessage(null);

    try {
      const res = await fetch("/api/analyze-market", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const json = await res.json();

      if (!res.ok) {
        setErrorMessage(
          json?.error ?? "Analysis failed. Please check your input and try again."
        );
        setViewState("error");
        return;
      }

      setResult(json as AnalyzeMarketResponse);
      setViewState("results");
    } catch {
      setErrorMessage(
        "Could not reach the analysis service. Please try again."
      );
      setViewState("error");
    }
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto max-w-5xl px-6 py-10">
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">
            Benchmark Scout
          </h1>
          <p className="mt-1 text-base text-slate-600">
            Local competitor intelligence from public web signals.
          </p>
          <p className="mt-3 max-w-2xl text-sm text-slate-500">
            Enter your business and market. Benchmark Scout finds local
            competitors, audits public websites, scans public signals, and
            shows where you stand.
          </p>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-8 px-6 py-10">
        <BusinessForm
          onSubmit={handleSubmit}
          isLoading={viewState === "loading"}
        />

        {viewState === "loading" && <LoadingSteps />}

        {viewState === "error" && errorMessage && (
          <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
            {errorMessage}
          </div>
        )}

        {viewState === "results" && result && (
          <ResultsDashboard data={result} />
        )}

        <footer className="border-t border-slate-200 pt-6 text-xs leading-relaxed text-slate-500">
          <p className="font-medium text-slate-600">How this demo works</p>
          <p className="mt-1 max-w-3xl">
            Benchmark Scout geocodes your market with Nominatim, discovers
            nearby businesses from OpenStreetMap/Overpass, audits public
            homepages for SEO/conversion/trust/content/technical signals,
            scans for public momentum, risk, offer, and hiring language, and
            checks GDELT for public news mentions. When free public data is
            sparse, labeled fallback demo rows are used so results stay
            available. Nothing here accesses private accounts, bypasses
            logins, or scrapes paywalled/CAPTCHA-protected content.
          </p>
        </footer>
      </main>
    </div>
  );
}
