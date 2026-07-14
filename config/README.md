# config/ — your plug-in points

Everything that makes this engine *yours* lives here. You never edit agent code to
onboard — you fill in these files. Copy `config.example.json` to `config.json` and
drop in the files below.

| File | What it is | Where it comes from |
|---|---|---|
| `config.json` | Master config — brand, platforms, schedule, approve-vs-auto, topics, Canva template IDs, scheduler + sheet IDs | Copy from `config.example.json` and fill in |
| `voice-fingerprint.md` | Your voice as checkable rules — makes everything sound like *you* | Run the [voiceprint](https://github.com/brie-wieselman/voiceprint) skill on your own writing |
| `content-rules.md` | Your brand/content canon (who you are, your audience, content rules) — the writer reads it BY HEADING | Write it yourself; see the heading list in `agents/brand-context.js` |
| `brand-visual-guide.md` | Your colors, fonts, visual do/don'ts — guides the Canva briefs | Write it yourself, or export from your brand kit |

## The three things people get wrong
1. **Use YOUR OWN Canva templates.** Map your saved brand-template IDs in
   `config.json → visual.canva_templates`. Never reuse someone else's templates.
2. **Start in `manual` topic mode.** You don't need any paid scraping APIs to run —
   just list your niche keywords and a few topic ideas. Turn on the scraper later if
   you want, with your own keys.
3. **Start in `approve` mode.** Nothing schedules until you say so. Flip to `auto`
   only once you trust the output.

## Getting your Canva template IDs (read this before filling in `visual.canva_templates`)

There are two separate paths, and almost everyone will use the first:

- **Handoff mode (default — no special Canva plan needed).** The value you put in
  `canva_templates` is just YOUR OWN reference label so the writer knows which
  template to point you at in the review email — it doesn't have to be a real API
  ID. The easiest reliable value: open your saved template in Canva, click **Share →
  Copy link**, and use that URL as the value. You'll click it yourself when you build
  the visual.
- **Connect API mode (optional, `CANVA_API_TOKEN` in `.env`).** This path calls
  Canva's Brand Template / Autofill API directly to autofill + export the PNG for
  you. As of Canva's current developer docs, **this API requires a Canva Enterprise
  plan** (both you as the integration owner and anyone using it) — non-Enterprise
  accounts get a limited trial only while an integration is in development, then must
  upgrade. If you're on a Pro or Free plan, skip this path and use Handoff mode — it
  isn't a downgrade, it's the intended default. If you do have Enterprise, get the
  real Brand Template ID from the Canva Developer Portal (`GET /v1/brand-templates`)
  or your template's own page — note Canva migrated to a new ID format in Sept 2025,
  so grab a fresh ID rather than reusing an old one from a tutorial.

## Using the optional trend scraper (`topics.mode: "scraper"`)

Skip this whole section if you're running in `manual` topic mode (the default) —
you don't need any of it.

If you turn the scraper on, know before you sign up for anything:
- **YouTube Data API** — free. [Enable it in Google Cloud Console](https://console.cloud.google.com/apis/library/youtube.googleapis.com) and generate a key; the free daily quota is generous enough for this use case.
- **RapidAPI** (powers the Reddit/X/Instagram/LinkedIn miners) — **this is normally a paid subscription**, not a free API. Pricing varies by provider on the [RapidAPI marketplace](https://rapidapi.com/hub) — expect roughly $5–30/month depending on which miners you turn on and your volume; check the specific listing's pricing tab before subscribing. Each miner that lacks a working key is skipped with a log line, so you can add scrapers one at a time as you decide they're worth the cost.
- You can turn on just one miner (e.g. YouTube only, since it's free) without paying for the others — the scout skips whatever it doesn't have a key for.

## Secrets
API keys never go in these files — they go in `.env` (see `.env.example`). The config
files hold IDs and preferences; `.env` holds the keys.
