# Benchmark Scout v0.4.0 release runbook

This release is maintenance-first and fail-closed. Rollback always restores
maintenance; it never reopens the v0.3.1 synthetic-report paths.

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
| `CACHE_DIR` | `/tmp/.cache` | Writable Vercel cache path. |
| `STRICT_ROBOTS` | `true` | Respect robots directives. |
| `KV_REST_API_URL` | Vercel/Upstash value | Durable v2 reports and samples. |
| `KV_REST_API_TOKEN` | Vercel/Upstash value | Durable v2 reports and samples. |
| `SAMPLE_REFRESH_SECRET` | Long random secret | Protect sample refresh. |

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
user audit, at least six real competitors, at least three successful
competitor audits, complete source resolution, and zero provenance violations.

Before launch, require exactly 12 active distinct-industry snapshots. Confirm
sample rotation, exclusion of the current sample, oldest age below 72 hours,
and health alerts below 10 active samples or above 72 hours.

## 5. Production cutover

1. Merge the green release and tag `v0.4.0`.
2. Deploy Production with maintenance still enabled.
3. Re-run health and containment probes.
4. Remove or set `MAINTENANCE_MODE=false`, then redeploy once.
5. Run six production smoke reports plus sample rotation, share/OG metadata,
   Sources Appendix, PDF, health, and runtime-log checks.

Launch remains blocked for synthetic provenance, unresolved sources,
accessible legacy reports, fewer than 12 active launch samples, any CI failure,
timeouts without a successful bounded retry, or production 5xx responses.

## 6. Rollback

Immediately set `MAINTENANCE_MODE=true` and redeploy. Keep monitoring available
through `/api/health`. Diagnose and repair v0.4.x behind maintenance; never
redeploy or reopen v0.3.1.
