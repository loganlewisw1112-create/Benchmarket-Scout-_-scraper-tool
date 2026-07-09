"use client";

import { useState } from "react";
import type { AnalyzeMarketRequest } from "@/lib/types";

export default function BusinessForm({
  onSubmit,
  isLoading,
}: {
  onSubmit: (payload: AnalyzeMarketRequest) => void;
  isLoading: boolean;
}) {
  const [businessName, setBusinessName] = useState("");
  const [businessUrl, setBusinessUrl] = useState("");
  const [businessType, setBusinessType] = useState("");
  const [market, setMarket] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!businessName || !businessUrl || !businessType || !market) return;
    onSubmit({ businessName, businessUrl, businessType, market });
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="grid grid-cols-1 gap-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:grid-cols-2"
    >
      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium text-slate-700">
          Business name
        </label>
        <input
          value={businessName}
          onChange={(e) => setBusinessName(e.target.value)}
          placeholder="Logan Lawn Care"
          maxLength={80}
          required
          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium text-slate-700">
          Business website
        </label>
        <input
          value={businessUrl}
          onChange={(e) => setBusinessUrl(e.target.value)}
          placeholder="https://example.com"
          maxLength={300}
          required
          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium text-slate-700">
          Business type
        </label>
        <input
          value={businessType}
          onChange={(e) => setBusinessType(e.target.value)}
          placeholder="landscaping, plumbing, dentist…"
          maxLength={80}
          required
          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium text-slate-700">
          City / market
        </label>
        <input
          value={market}
          onChange={(e) => setMarket(e.target.value)}
          placeholder="Dallas, TX"
          maxLength={120}
          required
          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
        />
      </div>

      <div className="sm:col-span-2">
        <button
          type="submit"
          disabled={isLoading}
          className="w-full rounded-lg bg-indigo-600 px-4 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
        >
          {isLoading ? "Analyzing…" : "Analyze Market"}
        </button>
      </div>
    </form>
  );
}
