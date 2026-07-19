# Benchmark Scout

## What it does

Benchmark Scout is a real-data-only local competitor intelligence tool. It
finds businesses through Nominatim and OpenStreetMap, audits public websites,
scans public news, ranks only successfully audited entities, generates
source-backed reports, and exports the same report to PDF.

## Run

```bash
npm install
npm run dev
```

## Checks

```bash
npm run lint          # eslint
npx tsc --noEmit      # typecheck
npm test              # vitest — offline, deterministic (no network)
npm run test:coverage # same suite with a v8 coverage report (report-only)
npm run check:real-data-only # reject production demo/mock paths
npm run build         # production build (warning-free)
```

CI (`.github/workflows/ci.yml`) runs lint, typecheck, test, and build on
every push and pull request.

## Open

http://localhost:3000

## Real-only data policy

Production reports use only user input, Nominatim, OpenStreetMap/Overpass,
public websites, linked public pages, and public news articles. Every report
has `schemaVersion: 2`, `provenance.policy: "real-only"`,
`containsSyntheticData: false`, and a complete Sources Appendix.

Missing or inaccessible evidence is `null` and renders as `N/A`. Discovered
businesses whose sites could not be audited remain visible but unscored.
Only successfully audited businesses participate in quantitative rankings.
If no usable real evidence exists, the API returns
`422 INSUFFICIENT_REAL_DATA` and saves nothing.

## Free sources

- **Nominatim** for market geocoding
- **Overpass / OpenStreetMap** for local competitor discovery
- **Public websites** for website audits (fetched directly, no paid APIs)
- **GDELT and linked public articles** for public news mentions

No paid APIs, no accounts, no Google Places/Yelp/SerpApi/LinkedIn/Instagram/
TikTok/X APIs are used anywhere in this project.

## PDF export

After a report is generated, click "Download PDF Report." PDF export is
generated client-side (via `jsPDF` + `jspdf-autotable`) from the same report
data already shown on the dashboard — no second backend call is made.

## Report quality

Reports are concise, deterministic, evidence-backed, and confidence-labeled.
Findings are directional public-signal observations, not verified internal
facts. Report text is generated from templates driven by computed scores and
signals — no LLM is used to generate report content. Findings, risks,
recommendations, signals, and competitors reference report-local source IDs
that resolve in the Sources Appendix.

## Project structure

```
app/
  page.tsx                      Dashboard UI (form, loading, results)
  api/analyze-market/route.ts   POST endpoint running the analysis pipeline
  api/health/route.ts           GET liveness endpoint (status/uptime/timestamp)
  api/sample-report/route.ts    GET a cached real Alameda County sample
  api/sample-report/refresh/    Protected catalog snapshot refresh
  api/reports/[id]/route.ts     Read a validated v2 report

components/                     Dashboard UI building blocks
components/*.test.tsx            Component tests (happy-dom + Testing Library)
lib/                             Pipeline: geocoding, discovery, auditing,
                                  signal extraction, scoring, report/PDF gen,
                                  rate limiting, robots.txt compliance,
                                  structured logging (lib/logger.ts)
lib/*.test.ts                    Vitest suite (offline: SSRF guard, validation,
                                  scoring, discovery, robots, rate limiting,
                                  provenance, storage, and route behavior)
instrumentation.ts               Next.js hooks: startup log + captured-error log
.github/workflows/               CI and sequential real-sample refresh
```

The API route is rate limited (10 requests/minute per client) since each
analysis fans out to several free public services. `/api/health` is exempt.

## Observability

Server logs are single-line JSON (`lib/logger.ts`) with per-request
correlation: every `/api/analyze-market` response carries an `x-request-id`
header, and all pipeline log lines for that request carry the same id
(propagated via AsyncLocalStorage — no logger parameter threading). Extend
logging by importing `logger` from `lib/logger.ts`; wire a real provider
later by swapping the `console.*` sink in that one file.

## Limitations

- Free OSM data does not reliably include ratings or reviews.
- Social platforms are not scraped behind logins or restrictions — only
  profile links found on public pages are surfaced.
- Findings are public signals, not verified internal business facts.
- Public data can be sparse, stale, or incomplete; unavailable values remain
  unscored and display as `N/A`.
- Old reports without valid v2 real-only provenance are intentionally
  inaccessible and return `410 LEGACY_REPORT_UNAVAILABLE`.

## Safety

- No private pages, no login bypass, no CAPTCHA bypass, no paywall bypass.
- robots.txt compliance (`lib/robots.ts`): set `STRICT_ROBOTS=true` and every
  website-audit fetch (homepages, linked pages, and each redirect hop) first
  checks the site's robots.txt, honoring user-agent groups, `Allow`/`Disallow`
  longest-match rules, `*` wildcards, and `$` anchors. Results are cached for
  24 hours; an unreachable or malformed robots.txt fails open so audits keep
  working. Off by default.
- SSRF protection (`lib/url-safety.ts`) blocks fetches to localhost, private
  IP ranges (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16), link-local addresses
  (including the 169.254.169.254 cloud metadata address), and IPv6
  loopback/private/link-local ranges. DNS results are re-checked, not just
  the literal hostname, and redirects are capped and re-validated.

## Environment variables

```bash
MAINTENANCE_MODE=true
APP_USER_AGENT="BenchmarkScout/0.1 (contact: your-email@yourdomain.com)"
CACHE_DIR=".cache"
STRICT_ROBOTS=false
SAMPLE_REFRESH_SECRET="replace-with-a-long-random-secret"
```

`MAINTENANCE_MODE=true` disables analysis, samples, stored reports, and shared
reports while keeping `/api/health` at `200` with `maintenance:true`.
`SAMPLE_REFRESH_SECRET` protects the real-sample refresh endpoint.

> **Important:** don't use `example.com` (or any address at that domain) in
> `APP_USER_AGENT`. Nominatim's and Overpass's edge networks actively block
> any request whose User-Agent contains `example.com` — it's a common
> leftover placeholder in unconfigured scrapers, so their WAFs treat it as a
> signal to reject the request outright (a 403/406 with no useful error
> body). Use a real contact address instead.

## Hosted deployment (Vercel)

See [DEPLOY.md](./DEPLOY.md) for the v0.4.0 maintenance-first launch and
rollback runbook. Report sharing (`/r/<id>`), waitlist capture
(`/api/waitlist`), cached real samples, and per-IP rate limiting are wired for
the public release.

### Additional environment variables

- `CACHE_DIR` - set to `/tmp/.cache` on Vercel (read-only project root).
- `KV_REST_API_URL` / `KV_REST_API_TOKEN` - Vercel KV (Upstash); required for
  durable saved reports and waitlist. Falls back to the filesystem locally.
- `SCOUT_API_KEY` - optional shared secret; when set, `/api/analyze-market`
  and `/api/waitlist` require it via the `x-scout-key` header or `?key=`.
- `MAINTENANCE_MODE` - set to `true` until every v0.4.0 launch gate passes.
- `SAMPLE_REFRESH_SECRET` - required by the protected sample refresh route.

### New endpoints

- `GET /api/reports/[id]` - fetch a saved report as JSON.
- `GET /api/sample-report?exclude=<sampleId>` - fetch one active cached real
  sample without external analysis.
- `POST /api/sample-report/refresh` - protected sequential refresh for one
  catalog ID.
- `POST /api/waitlist` - `{ email, source?, reportId? }`, validated + rate-limited.
- `GET /r/[id]` - shareable read-only report page.
