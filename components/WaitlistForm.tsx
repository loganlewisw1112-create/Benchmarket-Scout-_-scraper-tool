"use client";

import { useState } from "react";
import { jsonHeaders } from "@/lib/scout-client";

type Status = "idle" | "submitting" | "added" | "exists" | "error";

// Lightweight update signup and feedback form. Posts to /api/waitlist, which
// validates, rate-limits, and dedupes. Optional context (source / reportId) is
// recorded so we know which report drove a submission.
export default function WaitlistForm({
  source,
  reportId,
}: {
  source?: string;
  reportId?: string;
}) {
  const [email, setEmail] = useState("");
  const [feedback, setFeedback] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [statusMessage, setStatusMessage] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email) return;
    setStatus("submitting");
    setStatusMessage("");
    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({
          email,
          message: feedback.trim() || undefined,
          source,
          reportId,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setStatus("error");
        setStatusMessage(
          json?.error ?? "Something went wrong. Please try again."
        );
        return;
      }
      setStatus(json.status === "exists" ? "exists" : "added");
      setStatusMessage(json?.message ?? "Thanks!");
    } catch {
      setStatus("error");
      setStatusMessage("Could not reach the server. Please try again.");
    }
  }

  const done = status === "added" || status === "exists";

  return (
    <div className="rounded-xl border border-indigo-100 bg-indigo-50/60 p-5">
      <p className="text-sm font-semibold text-slate-900">
        Get updates or send feedback
      </p>
      <p className="mt-1 text-xs text-slate-600">
        Leave your email for product updates, and optionally tell us what worked
        or what went wrong.
      </p>

      {done ? (
        <p className="mt-3 rounded-lg bg-white px-3 py-2 text-sm font-medium text-indigo-700">
          {statusMessage}
        </p>
      ) : (
        <form
          onSubmit={handleSubmit}
          className="mt-3 flex flex-col gap-3"
        >
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="waitlist-email"
              className="text-xs font-medium text-slate-700"
            >
              Email
            </label>
            <input
              id="waitlist-email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@business.com"
              required
              maxLength={254}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="waitlist-feedback"
              className="text-xs font-medium text-slate-700"
            >
              Feedback{" "}
              <span className="font-normal text-slate-500">(optional)</span>
            </label>
            <textarea
              id="waitlist-feedback"
              value={feedback}
              onChange={(event) => setFeedback(event.target.value)}
              placeholder="Tell us what worked, what was confusing, or what you need next."
              maxLength={1000}
              rows={3}
              className="resize-y rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
          </div>
          <div>
            <button
              type="submit"
              disabled={status === "submitting"}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {status === "submitting" ? "Sending..." : "Send"}
            </button>
          </div>
        </form>
      )}

      {status === "error" && (
        <p className="mt-2 text-xs text-red-600">{statusMessage}</p>
      )}
    </div>
  );
}
