# Onboarding — stand up your own Content Machine

This guide takes you from a fresh clone to a running engine that produces articles,
Canva posts, and social copy in *your* voice, on a schedule, that you either approve
or let run automatically. No video, no voice cloning — just written + visual content.

Budget ~60–90 minutes for first setup. You do NOT need to be a developer, but you'll
run some terminal commands.

---

## What you'll end up with
A pipeline that, on your chosen days, will:
1. Pick topics (from your list, or optionally from trend-scraping)
2. Write articles + platform-specific social copy in your voice
3. Grade each draft against your voice spec; weak drafts get rewritten or dropped
4. Generate Canva post designs from *your* templates
5. Either email you for approval, or (if you choose) schedule automatically
6. Report what it did and how past posts performed

---

## Step 0 — Prerequisites
- **Node 20+** and **Python 3** (`brew install node` on Mac; Python ships with macOS)
- An **Anthropic API key** (the engine writes + grades with Claude)
- A **Google account** (the engine uses a Google Sheet as its database)
- A **Blotato account** (the multi-platform scheduler that actually posts)
- A **Canva account** with your own saved brand templates
- *(Optional)* your own **voiceprint** — see Step 2

## Step 1 — Clone + install
```bash
git clone https://github.com/brie-wieselman/content-machine.git
cd content-machine
npm install
```

## Step 2 — Build your voice fingerprint (the thing that makes it sound like you)
Install and run the companion skill on your own writing:
```bash
npx skills add brie-wieselman/voiceprint
```
Then, in Claude: **"build my voice fingerprint."** Give it 4–6 real samples of your
writing. Save the result as `config/voice-fingerprint.md`. This is what keeps every
piece in your voice instead of generic-AI voice.

## Step 3 — Fill in your config
```bash
cp config/config.example.json config/config.json
```
Open `config/config.json` and set: your brand name + handle, which **platforms** you
post to, your **topics** (start in `manual` mode — just list your niche + a few
ideas), your **Canva template IDs**, and `approval.mode` (**start with `approve`**).
See `config/README.md` for what each field means.

Also create:
- `config/content-rules.md` — your brand/content canon. Use the section headings the
  writer looks for (listed in `agents/brand-context.js`), e.g. `## WHO I AM`,
  `## MY AUDIENCE`, `## BRAND VOICE`, `## CONTENT RULES`.
- `config/brand-visual-guide.md` — your colors, fonts, visual do/don'ts.

## Step 4 — Set up the Google Sheet (the database)
1. Make a copy of the template sheet: **[TEMPLATE LINK — see note below]**
2. Copy its ID from the URL (`.../spreadsheets/d/THIS_PART/edit`)
3. Put it in `config.json → data.google_sheet_id`
4. Authorize Google locally (one time):
   ```bash
   gcloud auth application-default login --scopes=\
   https://www.googleapis.com/auth/spreadsheets,\
   https://www.googleapis.com/auth/gmail.send,\
   https://www.googleapis.com/auth/gmail.readonly
   ```

> **Note:** the sheet template ships in `docs/sheet-template.md` as a tab-by-tab spec
> you can recreate in a blank Google Sheet in ~5 minutes. (A one-click copy link is on
> the roadmap.)

## Step 5 — Add your keys
```bash
cp .env.example .env
```
Fill in your `ANTHROPIC_API_KEY`, `SCHEDULER_API_KEY` (Blotato), `MAIL_SENDER`, and —
only if you enabled the scraper — your `YOUTUBE_DATA_API_KEY` + `RAPIDAPI_KEY`.

## Step 6 — Prove the plumbing (no credentials, no network)
```bash
ORCH_MOCK=1 python3 orchestrator/run.py pipeline
```
This dry-runs the whole engine with deterministic mocks. If it completes, your wiring
is correct. Fix any path/config errors here before spending a single API credit.

## Step 7 — First real run
```bash
node pipeline.js --once
```
With `approval.mode: "approve"`, this produces content and emails you a review. Nothing
posts. Reply to approve the pieces you want; the scheduler queues those to your
platforms. Articles land in `output/articles/` as markdown + HTML.

## Step 8 — Put it on a schedule
```bash
python3 orchestrator/run.py gen-plists      # generates launchd jobs from your schedule
cp orchestrator/launchd/*.plist ~/Library/LaunchAgents/
for p in ~/Library/LaunchAgents/com.contentmachine.*.plist; do launchctl load "$p"; done
```
Now it runs on your chosen days automatically — still approval-gated unless you set
`approval.mode: "auto"`.

---

## The approve → auto graduation path
Start in `approve`. Watch the output for a couple of weeks. When you consistently
approve pieces without editing them, flip `approval.mode` to `auto` (or graduate a
single agent in `state.json`). The engine will even tell you when it thinks a stage has
earned it — but it never flips the switch itself. That's the core rule: the machine
does the labor, you keep the judgment.

## Troubleshooting
- **Mock run fails:** a path or config typo — read the error, it names the file.
- **"voice: not found":** your `config/voice-fingerprint.md` path is wrong.
- **Nothing schedules:** you're in `approve` mode (correct!) — check your email.
- **Off-brand content:** tighten `config/content-rules.md` and your on-topic keywords
  in `agents/brand-context.js`.
