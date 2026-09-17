<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/logo-dark.svg">
  <img alt="Benchmark Scout" src=".github/assets/logo-light.svg" width="380">
</picture>

<p><strong>Local competitor intelligence, built entirely from public web signals.</strong></p>

[![Live — open beta](https://img.shields.io/badge/live-open%20beta-4f46e5?style=flat-square)](https://benchmark-scout.vercel.app)
[![CI](https://github.com/loganlewisw1112-create/Benchmarket-Scout-_-scraper-tool/actions/workflows/ci.yml/badge.svg)](https://github.com/loganlewisw1112-create/Benchmarket-Scout-_-scraper-tool/actions/workflows/ci.yml)
![Next.js 16](https://img.shields.io/badge/Next.js-16-000000?style=flat-square&logo=nextdotjs)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178c6?style=flat-square&logo=typescript)
![Data: real-only](https://img.shields.io/badge/data-real--only-4338ca?style=flat-square)
![License: Proprietary](https://img.shields.io/badge/license-proprietary-64748b?style=flat-square)

<a href="https://benchmark-scout.vercel.app"><strong>benchmark-scout.vercel.app&nbsp;→</strong></a>

</div>

<p align="center">
  <a href="https://benchmark-scout.vercel.app">
    <img alt="Benchmark Scout — enter a business, type, and city; get a source-backed report" src=".github/assets/home.png" width="840">
  </a>
</p>

Give it a business, a type, and a city. It finds the real competitors nearby,
audits their public websites, pulls public news mentions, scores what it can
actually verify, and writes up a source-backed report you can read on screen,
share by link, or export to PDF.

The one rule the whole thing is built around: **it never makes a number up.**
Every figure traces back to something it actually fetched. When the evidence
isn't there, it says so instead of guessing.

## How it works

The analysis runs as a pipeline, one stage feeding the next:

1. **Geocode** the market with Nominatim to get a real bounding box.
2. **Discover** nearby businesses of the same type from OpenStreetMap via
   Overpass.
3. **Audit** each one's public website directly — structure, signals, linked
   public pages — no paid data brokers in the loop.
4. **Score** only the businesses whose sites actually audited. Anything it
   couldn't verify stays visible but unranked.
5. **Write** the report from those scores: findings, risks, a ranked
   comparison, and recommendations, each tied to a source ID.

<p align="center">
  <img alt="A Benchmark Scout report: score cards and a ranked local competitor landscape" src=".github/assets/report.png" width="840">
</p>
<p align="center"><sub>A slice of a real report — your score, your rank, and the ranked competitor landscape, every row sourced from public OSM data.</sub></p>

## The real-data rule

This is the part that makes the tool worth trusting, so it's enforced in code,
not just intended.

Every production report carries `schemaVersion: 2`,
`provenance.policy: "real-only"`, `containsSyntheticData: false`, and a full
Sources Appendix. A prebuild gate (`npm run check:real-data-only`) fails the
build if any demo or mock path can reach production.

When evidence is missing or unreachable, the value is `null` and renders as
`N/A` — it's never backfilled with an estimate. A discovered business whose
site won't audit stays in the list but sits out the rankings. And if a request
turns up no usable real evidence at all, the API returns
`422 INSUFFICIENT_REAL_DATA` and saves nothing. An empty answer is the honest
answer.

Report prose is generated from templates driven by the computed scores and
signals — **no LLM writes report content.** Findings are directional
observations about public signals, labeled with a confidence level, not claims
about a company's internal reality.

## Where the data comes from

- **Nominatim** — geocoding the market.
- **Overpass / OpenStreetMap** — discovering local competitors.
- **Public websites** — fetched directly for the audit, no third-party APIs.
- **GDELT and linked public articles** — public news mentions.

And, deliberately, nowhere else. No paid APIs, no accounts, and nothing from
Google Places, Yelp, SerpApi, LinkedIn, Instagram, TikTok, or X. Social
profiles show up only when a public page links to them.

## Run it locally

```bash
npm install
npm run dev
# http://localhost:3000
```

Set a real contact address in your user agent before hitting the public
services:

```bash
APP_USER_AGENT="BenchmarkScout/0.1 (contact: you@yourdomain.com)"
```

> Don't leave `example.com` in there. Nominatim's and Overpass's edge networks
> block any request whose User-Agent contains `example.com` — it's the classic
> unconfigured-scraper tell, so their WAFs reject it outright with an unhelpful
> 403/406. Use an address you actually own.

Other environment variables you may want locally:

```bash
CACHE_DIR=".cache"        # where fetched data and reports are cached
STRICT_ROBOTS=false       # when true, every audit fetch checks robots.txt first
MAINTENANCE_MODE=false    # when true, disables analysis but keeps /api/health up
```

## Tests and checks

```bash
npm run lint                  # eslint
npx tsc --noEmit              # typecheck
npm test                      # vitest — offline and deterministic, no network
npm run test:coverage         # same suite with a v8 coverage report
npm run check:real-data-only  # reject demo/mock paths reaching production
npm run build                 # production build, warning-free
```

The vitest suite runs entirely offline: SSRF guards, input validation, scoring,
discovery, robots parsing, rate limiting, provenance, storage, and route
behavior. CI (`.github/workflows/ci.yml`) runs lint, typecheck, test, and build
on every push and pull request.

## Deployment

The hosted build runs on Vercel with an Upstash (Vercel KV) store behind it, live in
open beta at **[benchmark-scout.vercel.app](https://benchmark-scout.vercel.app)**. It
needs the KV store plus a few environment variables — `KV_REST_API_URL` /
`KV_REST_API_TOKEN`, an optional `SCOUT_API_KEY`, and `MAINTENANCE_MODE` (a clean
holding state that keeps `/api/health` up while pausing analysis). The full list and
the launch/rollback steps are in [DEPLOY.md](./DEPLOY.md).

The API surface is small: `POST /api/analyze-market` runs the pipeline (rate-limited),
`GET /api/health` reports liveness, `GET /api/sample-report` returns a cached real
sample, `GET /api/reports/[id]` and `GET /r/[id]` read a saved report as JSON or as a
shareable page, and `POST /api/waitlist` handles signups.

## Project layout

`app/` holds the dashboard, the shareable report page (`r/[id]`), and the API routes
(analyze, reports, samples, waitlist, health). `lib/` is the pipeline itself —
geocoding, discovery, auditing, signals, scoring, report + PDF generation, rate
limiting, robots.txt, storage, and logging. `components/` is the UI with co-located
tests, and `scripts/` is operator tooling.

PDF export runs client-side (`jsPDF`) from the on-screen report — no second backend
call. Server logs are single-line JSON, each analyze response tagged with an
`x-request-id` that's propagated through AsyncLocalStorage and repeated on every log
line for that request.

## Safety

- **No bypassing anything.** No private pages, no login/paywall/CAPTCHA
  bypass — only what's publicly reachable.
- **SSRF protection** (`lib/url-safety.ts`) blocks fetches to localhost,
  private IP ranges (`10/8`, `172.16/12`, `192.168/16`), link-local addresses
  (including the `169.254.169.254` cloud-metadata endpoint), and the IPv6
  equivalents. It re-checks resolved DNS, not just the hostname, and caps and
  re-validates redirects.
- **robots.txt** (`lib/robots.ts`, opt-in via `STRICT_ROBOTS=true`): every
  audit fetch — homepages, linked pages, each redirect hop — first checks the
  site's robots.txt, honoring user-agent groups, longest-match
  `Allow`/`Disallow`, `*` wildcards, and `$` anchors. Results cache for 24h; an
  unreachable or malformed file fails open so audits keep working.

## Known limits

- Free OSM data doesn't reliably carry ratings or reviews.
- Public data is often sparse, stale, or incomplete; unavailable values stay
  unscored and show as `N/A`.
- Findings are public signals, not verified internal business facts.
- Social platforms are never scraped behind logins — only publicly linked
  profiles surface.
- Old reports without valid v2 real-only provenance are intentionally
  unreadable and return `410 LEGACY_REPORT_UNAVAILABLE`.

## Working on it

Stack: Next.js 16, React 19, TypeScript, Tailwind CSS 4, Zod, Vitest. Node 22+.

Heads up for contributors: this repo runs Next 16, which changed enough that
habits from older versions will bite you. See [AGENTS.md](./AGENTS.md) — read
the relevant guide under `node_modules/next/dist/docs/` before writing app code.

## License

Proprietary — all rights reserved. This is **not** open source; no permission
is granted to use, copy, publish, distribute, or sell it. See [LICENSE](./LICENSE).
