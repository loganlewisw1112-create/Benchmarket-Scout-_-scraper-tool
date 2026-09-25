# Benchmark Scout release runbook (v0.5.0)

Releases are maintenance-first and fail-closed. Rollback always restores
maintenance; it never reopens the v0.3.1 synthetic-report paths.

v0.5.0 is a hardening release on top of v0.4.0: per-endpoint rate limits,
same-site checks on JSON POSTs, typed 4xx errors, a health endpoint that
returns 503 when degraded, security headers, OSM attribution, and a Preview
guard that keeps Preview builds off the production KV store. Section 7 lists
the steps only the owner can do (Vercel, GitHub, and Upstash settings).

## 1. Contain production

Set `MAINTENANCE_MODE=true` for Production and deploy before changing the
pipeline. Verify:

- `/` and `/r/<any-id>` show the branded maintenance page.
- analysis, sample, and stored-report APIs return `503 MAINTENANCE`.
- `/api/health` returns `200` with `maintenance:true`.

Delete `DEMO_MODE` from every Vercel environment. Do not restore it during a
rollback.

## 2. Required environment

Configure Production and Preview as appropriate:

| Variable | Value | Purpose |
|---|---|---|
| `MAINTENANCE_MODE` | `true` in Production until launch | Fail-closed release gate. |
| `APP_USER_AGENT` | A real product/contact identifier | Required by Nominatim and Overpass. |
| `CACHE_DIR` | `/tmp/.cache` | Writable Vercel path for the file cache. With KV configured, only homepage audits use it (per-instance, wiped on a cold start); the geocode (30 d), Overpass discovery (72 h fresh, 14 d stale-if-error), robots.txt (24 h) and full-analysis (6 h) caches live in KV under expiring `cache:v1:*` keys and are shared by every instance. Without KV everything falls back to this path. |
| `STRICT_ROBOTS` | `true` | Respect robots directives. |
| `KV_REST_API_URL` | Vercel/Upstash value, **Production only** | Durable v2 reports and samples, plus the shared data cache. |
| `KV_REST_API_TOKEN` | Vercel/Upstash value, **Production only** | Durable v2 reports and samples, plus the shared data cache. |
| `SAMPLE_REFRESH_SECRET` | Long random secret | Protect sample refresh. |
| `NEXT_PUBLIC_SITE_URL` | `https://benchmark-scout.vercel.app` | Canonical origin for canonical links, Open Graph URLs, robots.txt, and sitemap.xml. Set the same value on every project and domain so duplicates point back at the primary. |
| `ALLOW_PREVIEW_KV` | unset (only `true` to override) | See below. |

**Preview builds never use production KV by default.** When
`VERCEL_ENV=preview` and `ALLOW_PREVIEW_KV` is not exactly `true`, the app
ignores any `KV_*` credentials, logs one warning, and uses the ephemeral
filesystem store instead. `/api/health` then reports `previewKvBlocked: true`.
Only set `ALLOW_PREVIEW_KV=true` on a Preview that has its **own** separate KV
database, never to point a Preview at production data. The real fix is still
to remove `KV_*` and `REDIS_URL` from the Preview environment (section 7).

`vercel.json` also turns off automatic deployments for `dependabot/**`
branches, so dependency PRs are checked by CI only and never get a Preview
build with project secrets. Vercel reads `vercel.json` from the commit being
built, so this takes effect for Dependabot branches cut after it is merged to
`master`. It does not set `regions`; functions stay in the project default
(`iad1`), close to the KV store.

The same `SAMPLE_REFRESH_SECRET` must be stored as a GitHub Actions repository
secret for the daily refresh workflow. Never write it to source, logs, or
workflow output.

## 3. CI and preview gate

Run locally and in CI:

```powershell
npm ci
npm run check:real-data-only
npm test
npx tsc --noEmit
npm run lint
npm run build
```

Deploy a gated Vercel Preview. Run the curated 25 Alameda County inputs at
least 65 seconds apart. Each successful run must persist and render through a
working share URL. Bounded retries are allowed only for typed retryable source
outages.

If Vercel Deployment Protection is enabled, create a temporary project
automation bypass and provide it only to the gate process as
`VERCEL_AUTOMATION_BYPASS_SECRET`. The gate sends it as the documented
`x-vercel-protection-bypass` header on analysis, stored-report, and shared-page
requests. Revoke the temporary bypass after preview validation.

Validate every produced report:

- `schemaVersion` is `2` and provenance policy is `real-only`.
- `containsSyntheticData` is exactly `false`.
- every `sourceId` resolves and the Sources Appendix is complete.
- unavailable fields render as `N/A`; unaudited competitors are unscored.
- no modeled uplift, mock source, demo text, zero padding, or approximate
  coordinates appear.
- old/non-v2 reports return `410 LEGACY_REPORT_UNAVAILABLE`.

Render all 25 share pages. Verify PDF output on at least five representative
complete and partial reports.

## 4. Real sample gate

Refresh candidates sequentially through `POST /api/sample-report/refresh`
using header `x-sample-refresh-secret` and body `{ "catalogId": "..." }`.
Only snapshots passing the sample quality gate can become active: successful
user audit, at least four real competitors, at least two successful
competitor audits, complete source resolution, and zero provenance violations.

Before launch, require exactly 12 active distinct-industry snapshots. Confirm
sample rotation, exclusion of the current sample, and that `/api/health`
returns `200` with `status: "ok"`.

### What `/api/health` means

It measures only what users are actually served:

- `200`, `status: "ok"`: at least 10 samples are fresher than 72 hours, the
  samples being served are all within 72 hours, and the durable store is
  reachable.
- `503`, `status: "degraded"`: one or more of `ACTIVE_SAMPLES_LOW` (fewer than
  10 fresh samples), `SERVED_SAMPLES_STALE` (the pool is falling back to
  retained samples up to 30 days old, or the oldest served sample is past
  72 hours), or `DURABLE_STORE_UNAVAILABLE`. The body lists them in
  `alertReasons`.
- `200`, `status: "maintenance"`: maintenance is on. Alerts are still
  reported in the body.

A `200` may be cached at the edge for 30 seconds; a `503` is `no-store`. The
endpoint is not rate-limited and does not log each poll.

A sample-pool alert means the daily refresh is not keeping up. It does not by
itself mean reports are wrong: fix the refresh (the `Refresh real sample
reports` workflow) rather than rolling back. The usual cause is public
Overpass being down. A refresh reuses a competitor search under 72 hours old
without asking Overpass, and falls back to one up to 14 days old if every
Overpass instance fails; either way the report's notes carry the list's
original retrieval date. A catalog entry with no saved search still fails
with `SOURCE_UNAVAILABLE` until Overpass recovers. A `DURABLE_STORE_UNAVAILABLE`
alert does break saving and sharing reports, and warrants maintenance if it
lasts.

### Uptime monitoring, honestly

`.github/workflows/uptime.yml` is scheduled every 10 minutes, but GitHub runs
low-priority schedules late or not at all: in Aug-Sep 2026 it actually ran
about 2-9 times a day (median gap about 2 hours, worst gap about 12 hours).
Treat it as a backstop that files and closes a GitHub issue, not as alerting.
Minute-level detection needs an external monitor (section 7) pointed at
`/api/health`, alerting on any non-200.

## 5. Production cutover

1. Merge the green release and tag it (`v0.5.0` for this release).
2. Deploy Production with maintenance still enabled.
3. Re-run health and containment probes.
4. Remove or set `MAINTENANCE_MODE=false`, then redeploy once.
5. Run six production smoke reports plus sample rotation, share/OG metadata,
   Sources Appendix, PDF, health, and runtime-log checks.
6. Check the security headers on `/`, `/r/<id>`, and `/api/health` (for
   example `curl -sI`): `Content-Security-Policy`, `X-Frame-Options: DENY`,
   `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`,
   and no `X-Powered-By`. Then load the home page, run a report, open a share
   link, and download a PDF (including one with a non-Latin business name)
   with the browser console open: there must be no CSP violations. Confirm
   Vercel Web Analytics still records page views.
7. Check `/robots.txt`, `/sitemap.xml`, and the `<link rel="canonical">` on
   `/`, `/privacy`, and a `/r/<id>` page (all pointing at the primary domain).

Launch remains blocked for synthetic provenance, unresolved sources,
accessible legacy reports, fewer than 12 active launch samples, any CI failure,
timeouts without a successful bounded retry, or production 5xx responses.

## 6. Rollback

Roll back for anything that breaks the real-data rule or the product itself:
synthetic provenance, unresolved sources, readable legacy reports, sustained
5xx on analysis or report pages, or a durable store that stays unavailable.
Immediately set `MAINTENANCE_MODE=true` and redeploy. Keep monitoring available
through `/api/health`. Diagnose and repair behind maintenance; never redeploy
or reopen v0.3.1.

If the Content Security Policy breaks something in production (blank page,
PDF download blocked, analytics missing), promote the previous deployment in
Vercel first, then fix the policy in `next.config.ts`
(`buildContentSecurityPolicy`) and add a test for the missing source.

## 7. Owner actions

These need account access, so no code change can do them. Tick them off
after the v0.5.0 merge:

- [ ] **Remove `KV_*` and `REDIS_URL` from the Preview environment** on both
      Vercel projects (`benchmark-scout` and `benchmarket-scout-scraper-tool`).
      Keep them on Production only.
- [ ] **Delete or disconnect the duplicate project**
      `benchmarket-scout-scraper-tool`. It serves the same app from the same
      KV store with no `MAINTENANCE_MODE`, so maintenance on the primary does
      not contain it. If it must stay, set `MAINTENANCE_MODE` and
      `NEXT_PUBLIC_SITE_URL=https://benchmark-scout.vercel.app` on it.
- [ ] **Rotate the Upstash KV token** (Preview builds, including Dependabot
      branches, have had it), then update the Production env vars and
      redeploy.
- [ ] **Enable branch protection on `master`**: require the CI check and a
      pull request; no force pushes.
- [ ] **Add an external uptime monitor** on
      `https://benchmark-scout.vercel.app/api/health`, alerting on any non-200.
- [ ] **Set Upstash budget and usage alerts** on the KV database.
- [ ] Optional: add a Vercel log drain if logs need to outlive Vercel's
      retention.
- [ ] **Prune old deployments** in both Vercel projects, keeping the current
      production deployment and a known-good rollback target.
- [ ] **Tag `v0.5.0`** on the merge commit and push the tag.
