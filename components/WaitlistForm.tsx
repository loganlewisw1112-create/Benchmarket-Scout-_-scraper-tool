"use client";

import { useState } from "react";
import { jsonHeaders } from "@/lib/scout-client";

type Status = "idle" | "submitting" | "added" | "exists" | "error";

// Lightweight email capture. Posts to /api/waitlist, which validates,
// rate-limits, and dedupes. Optional context (source / reportId) is recorded
// so we know which report drove a signup.
export default function WaitlistForm({
  source,
  reportId,
}: {
  source?: string;
  reportId?: string;
}) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email) return;
    setStatus("submitting");
    setMessage("");
    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ email, source, reportId }),
      });
      const json = await res.json();
      if (!res.ok) {
        setStatus("error");
        setMessage(json?.error ?? "Something went wrong. Please try again.");
        return;
      }
      setStatus(json.status === "exists" ? "exists" : "added");
      setMessage(json?.message ?? "Thanks!");
    } catch {
      setStatus("error");
      setMessage("Could not reach the server. Please try again.");
    }
  }

  const done = status === "added" || status === "exists";

  return (
    <div className="rounded-xl border border-indigo-100 bg-indigo-50/60 p-5">
      <p className="text-sm font-semibold text-slate-900">
        Get the full PDF and product updates
      </p>
      <p className="mt-1 text-xs text-slate-600">
        Leave your email and we will send the full report and let you know when
        saved reports and monitoring go live.
      </p>

      {done ? (
        <p className="mt-3 rounded-lg bg-white px-3 py-2 text-sm font-medium text-indigo-700">
          {message}
        </p>
      ) : (
        <form
          onSubmit={handleSubmit}
          className="mt-3 flex flex-col gap-2 sm:flex-row"
        >
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@business.com"
            required
            maxLength={254}
            className="flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          />
          <button
            type="submit"
            disabled={status === "submitting"}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {status === "submitting" ? "Sending..." : "Notify me"}
          </button>
        </form>
      )}

      {status === "error" && (
        <p className="mt-2 text-xs text-red-600">{message}</p>
      )}
    </div>
  );
}
