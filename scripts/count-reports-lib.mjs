// Pure, backend-agnostic helpers for scripts/count-reports.mjs, split out so the
// honesty-critical logic — which keys count as a "report run", and how many
// businesses a stored report attests to — can be unit-tested without a live KV
// or filesystem store. No I/O here.

// Stored reports live under two key shapes (see lib/store.ts):
//   report:v2:<id>   current schema, written by saveReport
//   report:<id>      pre-v2 legacy, treated as unreadable by the app
// A SCAN over "report:*" returns both, so callers must partition, NOT fold: a
// legacy key must never be counted as a v2 run, and a v2 key must never be
// double-counted as legacy just because it also starts with "report:".
export const V2_PREFIX = "report:v2:";

export function partitionReportKeys(keys) {
  const v2 = [];
  const legacy = [];
  for (const key of keys) {
    if (typeof key !== "string") continue;
    if (key.startsWith(V2_PREFIX)) v2.push(key);
    else if (key.startsWith("report:")) legacy.push(key);
    // Anything else was matched by a broader glob than intended; drop it rather
    // than guess which bucket it belongs in.
  }
  return { v2, legacy };
}

// Extract summary.competitorCount from a stored v2 report payload (the raw JSON
// string of { schemaVersion, id, createdAt, report }). Returns the count as a
// number, or null when the payload is missing/malformed or lacks a finite
// numeric count. Null means "unreadable" — the caller counts it separately
// rather than silently adding 0, which would understate the total with no
// warning.
export function competitorCountFromRaw(raw) {
  if (typeof raw !== "string" || raw.length === 0) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const count = parsed?.report?.summary?.competitorCount;
  return typeof count === "number" && Number.isFinite(count) ? count : null;
}
