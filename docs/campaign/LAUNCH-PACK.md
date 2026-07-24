# Benchmark Scout — 14-day launch pack

Everything needed to post. Assets are in `out/`, rendered from the
`card-dayNN.html` sources by `render.ps1`.

## Before day 1

- [ ] Merge and deploy PR #14 (report overflow fix + OG image + analytics).
      The overflow fix must be live before Day 2 — that card advertises
      `/r/<id>`, which is the page that was rendering citations across the
      neighbouring column.
- [ ] **Enable Web Analytics in the Vercel project dashboard.** The package
      does not collect anything until it is switched on there.
- [ ] Re-crawl the share preview with the X and LinkedIn card validators.
- [ ] Confirm `benchmark-scout.vercel.app` still serves the app (no key gate).

## Link + UTM scheme

Base: `https://benchmark-scout.vercel.app/`

```
?utm_source=<li|x|ig|fb|reddit>&utm_medium=social&utm_campaign=founding100&utm_content=dayNN
```

Post the tagged link in the caption. The card art deliberately prints the bare
domain — a visible UTM string reads as tracking spam and isn't clickable.

Day 13 points at the feedback anchor instead:
`https://benchmark-scout.vercel.app/#feedback?...`

## The 14 days

Captions are drafts — tighten to your voice, but do not add numbers or quotes
that aren't in here. See "Claims discipline" below.

**Day 1 — Launch / thesis** · LinkedIn + X · `day01-launch-1080x1350.png`
> Most local businesses have never actually looked at the competitor that's
> beating them. Not guessed at — looked at.
>
> Benchmark Scout pulls real public signals on your local market and shows you
> where you stand. Free, no login.

**Day 2 — Live demo** · X + Instagram · `day02-demo-1080x1350.png`
> This is a real report, not a mockup. Real competitors, discovered from public
> map and web data, each figure traceable to the source it came from.
>
> Run one on your own business and see where you land.

**Day 3 — Problem-agitate (agencies)** · LinkedIn · `day03-agencies-1080x1350.png`
> If you build competitor reports for clients, you already know the job: same
> research, every month, every account.
>
> This builds it from public data with the sources attached — so your client
> can check the work instead of taking your word for it.

**Day 4 — Myth-bust** · X + Instagram · `day04-mythbust-1080x1350.png`
> Plenty of "competitor tools" quietly estimate the numbers they show you.
>
> Here's every source ours pulls from. Where the evidence doesn't exist, the
> report says N/A instead of inventing something.

**Day 5 — Interactive lead-gen** · X + LinkedIn · `day05-leadgen-1080x1080.png`
> Comment your business and your city and I'll run the competitor report and
> send it back. Free, however many people ask.
>
> (Reply with the report link, then ask what was missing — this is the warmest
> feedback source in the whole campaign.)

**Day 6 — What you get** · Instagram + Facebook · `day06-whatyouget-1080x1350.png`
> Three things, one report: where you rank locally, what your site is costing
> you, and which gaps to close first.
>
> Every finding cites its source.

**Day 7 — Founding 100 reveal** · LinkedIn + X + Instagram · `day07-founding100-1080x1350.png`
> We're taking 100 founding testers.
>
> Run a report on a business you care about, tell us what was useful and what
> was missing, and you get Recon — the monitoring layer we're building next —
> free for three months when it ships.

**Day 8 — Building in public** · LinkedIn + X · `day08-buildinpublic-1080x1350.png`
> Honest status: we've built a report worth reading once. We have not yet built
> the reason to come back. That's the next thing we're building, and we'd
> rather 100 people tell us what it needs than guess at it.

**Day 9 — Feature tease (Recon)** · X + Instagram · `day09-recon-1080x1080.png`
> Next up: Recon re-runs your report on a schedule and tells you when your
> market moves.
>
> It isn't live yet. The report that powers it is — test that.

**Day 10 — Watch it change** · Instagram + LinkedIn · `day10-rerun-1080x1350.png`
> One snapshot tells you where you stand. Two tell you which direction you're
> moving. Run it today, run it again in two weeks.

**Day 11 — Agency angle** · LinkedIn · `day11-agency-1080x1350.png`
> One report per client. Export the PDF or just send the link — your client
> needs no login to open it.
>
> Branded reports aren't built yet. The Founding 100 decide what ships first.

**Day 12 — Urgency** · X + Instagram Story · `day12-urgency-1080x1920.png`
> ⚠️ Fill the number first — see below.

**Day 13 — Feedback callout** · LinkedIn + X + Instagram · `day13-feedback-1080x1350.png`
> If you've run a report: what's the one thing it's missing?
>
> Whatever you answer is the roadmap. Two minutes, in the box under your report.

**Day 14 — Recap / close** · all · `day14-recap-1080x1350.png`
> ⚠️ Fill the number first — see below.

Plus daily Stories and native (non-image) text posts reusing the same hooks in
Reddit and marketing Slack groups.

## Filling the two placeholder numbers

Days 12 and 14 render a highlighted `NN`. That is deliberate — an unedited card
looks broken so it can't be posted by accident. Edit the `<span class="ph">` in
the card HTML, then re-run `render.ps1`.

**Day 12 — spots left.** `100 −` the number of founding testers so far:

```bash
# needs production KV credentials in the environment
node scripts/export-waitlist.mjs --format json --out ./ops/waitlist
```

The export dedupes by email; entries carrying `source: "report"` are people who
submitted from under a finished report.

**Day 14 — markets scouted.** Count reports run — one report = one local market
scouted, which is the unit the card now names ("NN local markets scouted"):

```bash
# needs production KV credentials in the environment
node scripts/count-reports.mjs
```

Use the **"Reports run (v2)"** line. Deliberately *not* "businesses scouted":
summing competitors across reports counts the same shop twice whenever two runs
scout it, so it isn't a defensible distinct-business figure — one report = one
market is. The count is last-90-days only (report keys carry a 90-day TTL); for
a two-week-old launch that's effectively all-time. Legacy pre-v2 reports are
reported on their own line and are not in the headline number.

Do not estimate it. A campaign whose entire wedge is "we don't make the numbers
up" cannot post an invented headline figure on its closing day.

## Claims discipline

Three things are true and easy to forget under posting pressure:

- **No testimonials exist yet.** The quotes and the NPS figure in
  `retention-report.html` come from a simulated corpus, not real users. They
  cannot be quoted publicly. Day 6 and Day 8 were rewritten for this reason.
- **Recon does not exist.** Every mention stays future-tense. If the timeline
  slips past the free-3-months promise, Day 7 is a commitment you're carrying.
- **White-label does not exist.** It's a feature request, not a feature. Day 11
  says so explicitly.
- **No timing claims.** "One sitting", never "30 seconds" — it has never been
  measured.

## Measuring it

| # | Metric | Target | Source |
|---|--------|--------|--------|
| 1 | Reports run by new people | ≥ 100 | Vercel Analytics + UTM `utm_content` |
| 2 | Structured feedback | ≥ 30 | `export-waitlist.mjs` |
| 3 | Comment/DM "run mine" replies | ≥ 60 | Manual, per platform |
| 4 | Week-2 return runs | track | Analytics returning visitors |

Not optimising for impressions, followers, or likes.
