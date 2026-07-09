# Contributing to Benchmark Scout

## Setup

```bash
npm install
cp .env.example .env.local   # optional; defaults work out of the box
npm run dev                  # http://localhost:3000
```

## Checks

Run all of these before committing — CI runs the same set:

```bash
npm run lint        # eslint
npx tsc --noEmit    # typecheck
npm test            # vitest (offline, deterministic)
npm run build       # production build (must be warning-free)
```

## Conventions

- TypeScript strict mode; no `any` unless unavoidable.
- All external fetches must go through the safety layer: URL normalization and
  SSRF checks (`lib/url-safety.ts`), timeouts, byte caps, and redirect caps
  (see `lib/audit.ts` for the pattern).
- New pipeline logic belongs in `lib/`; UI in `components/`; keep the API route
  (`app/api/analyze-market/route.ts`) thin.
- Tests must run offline — no test may depend on Nominatim, Overpass, GDELT,
  or any live website. Use `demoMode: "mock"` and unroutable/private URLs
  (e.g. `https://127.0.0.1`) to force deterministic paths.
- Commit messages: short imperative subject; body explains why when non-obvious.

## Notes

- This repo pins Next.js 16 — conventions may differ from older Next.js.
  Consult `node_modules/next/dist/docs/` before assuming an API's behavior
  (see `AGENTS.md`).
- Never commit `.env.local`, `.cache/`, or `.next/` (all gitignored).
