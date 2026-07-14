# Deploying Benchmark Scout to Vercel

Standard Next.js project. Vercel auto-detects the framework (no `vercel.json`
needed). This deploys a **gated** public beta: reports run behind a shared
access code, plus per-IP rate limiting, with report sharing and waitlist
capture.

## 1. One-time: clear the stale git lock, drop line-ending noise, commit + push

A stale `.git/index.lock` (0 bytes, from a crashed process on Jul 12) is
blocking commits. In the `Scraper` folder on your machine:

```powershell
del .git\index.lock
# drop pre-existing CRLF/LF churn so the feature diff stays clean:
git checkout -- package.json package-lock.json .github/workflows/ci.yml
git add -A
git commit -m "feat: gated hosted beta - report sharing, waitlist, key gate, landing page"
git tag v0.2.0
git push origin HEAD --tags
```

CI (lint + typecheck + test + build) runs on push and must be green before you
promote the deployment.

## 2. Generate the access code + its hash

```
node -e "const c=require('crypto');const k=c.randomBytes(24).toString('base64url');console.log('ACCESS CODE (share with beta users):',k);console.log('SCOUT_API_KEY_HASH (set in Vercel):',c.createHash('sha256').update(k).digest('hex'))"
```

Keep the ACCESS CODE to hand out; only the hash goes into Vercel. Beta users
paste the code into the "Access code" field on the site (stored on their
device, sent as the `x-scout-key` header).

## 3. Provision Vercel KV (durable share links + waitlist)

Vercel dashboard: **Storage -> Create -> KV (Upstash Redis)**, connect to this
project. `KV_REST_API_URL` and `KV_REST_API_TOKEN` are injected automatically.
Without KV, saved reports fall back to ephemeral `/tmp` and share links break
across instances.

## 4. Import the project and set environment variables

Import `github.com/loganlewisw1112-create/Benchmarket-Scout-_-scraper-tool`
(**Add New -> Project**). Set (Production + Preview):

| Variable | Value | Why |
|---|---|---|
| `APP_USER_AGENT` | `BenchmarkScout/1.0 (contact: github.com/loganlewisw1112-create/Benchmarket-Scout-_-scraper-tool)` | Nominatim/Overpass reject example.com. Use a real, reachable contact. |
| `SCOUT_API_KEY_HASH` | (hash from step 2) | Gates the beta; raw code never stored server-side. |
| `DEMO_MODE` | `auto` | Live public data first, labeled fallback when sparse. |
| `CACHE_DIR` | `/tmp/.cache` | Project root is read-only on Vercel; only `/tmp` is writable. |
| `STRICT_ROBOTS` | `true` | Respect robots.txt on a public deployment. |
| `KV_REST_API_URL` | (auto, step 3) | Durable report/waitlist store. |
| `KV_REST_API_TOKEN` | (auto, step 3) | Durable report/waitlist store. |

To open the beta to everyone later, just remove `SCOUT_API_KEY_HASH`.

## 5. Deploy and verify

On the live URL:

- Landing page renders; entering the access code, then **See a sample report**,
  returns results (without a valid code, analyze returns HTTP 401).
- A real report shows a **Share this report** link; opening `/r/<id>` in a
  fresh browser shows the same report.
- Waitlist email returns success; a duplicate reports "already on the list".
- Rapid repeated analyze calls eventually return HTTP 429.
- `/api/health` returns `{ "status": "ok" }`.

## Notes

- Node: CI uses Node 24; set Vercel **Node.js Version** to 22.x or 24.x.
- Rate limit: 10 requests / 60s per IP (`lib/rate-limit.ts`), enforced across
  instances via KV when configured.
