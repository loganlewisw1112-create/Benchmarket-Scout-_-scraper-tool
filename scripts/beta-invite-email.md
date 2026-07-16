# Beta invite email template

Manual-send template for inviting waitlist signups (exported via
`scripts/export-waitlist.mjs`) to the hosted Benchmark Scout beta. Copy the
subject and body into your email client, fill in the placeholders per
recipient, and send by hand. There is no automated sending here on purpose.

Placeholders:
- `{{first_name}}` -- optional; drop the whole greeting clause if you don't
  have a name for that row (e.g. just "Hi there,").
- `{{access_code}}` -- the beta access code you've issued them (matches
  whatever is configured via `SCOUT_API_KEY` / `SCOUT_API_KEY_HASH`). They'll
  paste it into the "Access code" field on the landing page.

---

**Subject:** You're in -- Benchmark Scout beta access

**Body:**

```
Hi {{first_name}},

You signed up for early access to Benchmark Scout, so here you go -- you're in.

What it does: point it at a business's website and a few public sources, and
it pulls together a benchmark report -- competitors, positioning, and gaps --
in a couple of minutes instead of an afternoon of manual digging.

Try it here: https://benchmarket-scout-scraper-tool.vercel.app
Your access code: {{access_code}}
(Paste the code into the "Access code" field on the page.)

It's still early, so things may be rough around the edges. If you hit a bug,
get a confusing result, or just have thoughts on what would make this more
useful -- reply to this email. I read every reply and it directly shapes
what gets built next.

Thanks for signing up,
Logan
```
