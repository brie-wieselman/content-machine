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

## Secrets
API keys never go in these files — they go in `.env` (see `.env.example`). The config
files hold IDs and preferences; `.env` holds the keys.
