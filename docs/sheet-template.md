# Google Sheet template — the engine's database

The engine uses one Google Sheet as its shared database: every agent reads
and/or appends rows here, and the sheet doubles as your human-readable
dashboard. There is no one-click copy link yet — but the whole thing is six
tabs of plain columns, so you can recreate it in a blank sheet in about five
minutes:

1. Create a blank Google Sheet.
2. Rename/add tabs so you have the six tab names below, **spelled exactly**
   (agents address tabs by name).
3. Paste each tab's column headers into row 1.
4. Copy the sheet ID from the URL (`.../spreadsheets/d/THIS_PART/edit`) into
   `config.json → data.google_sheet_id`.
5. Make sure the Google account you authorized locally (ONBOARDING.md Step 4)
   can edit the sheet.

Agents only ever **append** rows (plus status-cell updates); they never
reorder or delete. If a Sheets write fails, the rows are saved as JSON under
`output/` for manual import — no signal is lost.

---

## Tab 1: `Daily Outlier`

Trend-scout results: videos performing far above their channel's own average.

**Written by:** `agents/agent2-scout.js` (only in scraper topic mode)
**Read by:** the writer stage, as topic/hook inspiration (structure only)

| Column | Meaning |
|---|---|
| Date | Run date (YYYY-MM-DD) |
| Platform | Source platform (`YouTube`) |
| Creator | Channel name from your watch list |
| Subscriber Count | Channel subscribers at mine time |
| Title | The outlier video's title |
| URL | Link to the video |
| Views | Cumulative views at mine time |
| Outlier Score | `(views / channel's avg recent views) * 100` — >200 strong, >500 viral |
| Hook Type | Heuristic class: myth-bust / confession / mechanism / authority / pattern-interrupt |
| Hook Text | First non-empty description line (title fallback) — a proxy for the spoken hook |
| Suggested Title | Templated starting point for your own version |
| Suggested Hook | Templated hook matching the Hook Type |
| Lane | Which content lane the source channel belongs to (from your config) |
| Status | `STRONG` / `VIRAL`, plus ` / <50K` when the channel is small (their wins are the most replicable) |

## Tab 2: `Social Pulse`

Audience tensions mined from Reddit, X, Instagram, and LinkedIn — what your
audience is asking, venting about, and celebrating this week.

**Written by:** `agents/agent2-scout.js` (only in scraper topic mode)
**Read by:** the writer stage, for topic angles

| Column | Meaning |
|---|---|
| Date | Run date (YYYY-MM-DD) |
| Platform | `Reddit` / `X/Twitter` / `Instagram` / `LinkedIn` |
| Source | Subreddit, search term, or account/profile the item came from |
| Post Title | First line / title of the post |
| URL | Link to the post |
| Engagement | Upvotes or weighted engagement (likes + comments×5 + reposts×3) |
| Top Comment | Highest-voted reply (Reddit), or format metadata for other platforms |
| Core Tension | One-line read of what the poster actually wants |
| Content Angle | Suggested way to answer that tension in your content |
| Hook Draft | Hook-type label + the post's opening, as a structural reference |
| Reference File | Local path under `output/scout/references/` for high performers (full structure notes) |
| Status | `NEW` on append; flip it yourself as you use items (`USED`, `SKIP`) |

## Tab 3: `Content Calendar`

The production queue: every piece the engine drafts, its approval state, and
where it ended up.

**Written by:** the writer stage (new drafts), the approval handler (status
changes), and the scheduler (scheduled time + post ID)
**Read by:** the scheduler (what's approved), the daily reporter (what
happened today)

| Column | Meaning |
|---|---|
| Date | Draft date (YYYY-MM-DD) |
| Platform | Target platform for this piece |
| Content Type | e.g. `article`, `carousel`, `static`, `text-post` |
| Topic | The topic or idea the piece answers |
| Hook | The piece's opening hook |
| Copy | Caption / post body (articles keep only a pointer here; full text lives in `output/articles/`) |
| Asset Link | Link/path to the visual asset, if any |
| Status | `DRAFT` → `PENDING_REVIEW` → `APPROVED` / `DECLINED` → `SCHEDULED` → `POSTED` |
| Scheduled Time | When the scheduler queued it for |
| Post ID | Scheduler/platform ID once queued (joins to Performance Log) |

## Tab 4: `Brand Voice`

A compact, current snapshot of your voice rules — kept in sync with your
`config/voice-fingerprint.md` so you can audit at a glance what the writer is
being held to.

**Written by:** the voice-maintenance stage (when you run it) or you, by hand
**Read by:** you, for auditing; the source of truth for generation stays the
fingerprint + content-rules files in `config/`

| Column | Meaning |
|---|---|
| Element | What kind of rule (banned word, sentence rhythm, platform note, ...) |
| Rule | The rule itself, stated checkably |
| Example | A concrete pass/fail example |
| Last Updated | YYYY-MM-DD |

## Tab 5: `Performance Log`

How published pieces actually performed — the feedback loop.

**Written by:** the performance/analyst stage (pulls metrics for posted
pieces), or you, by hand
**Read by:** the analyst stage (what to make more/less of), the daily reporter

| Column | Meaning |
|---|---|
| Date | Metric-pull date (YYYY-MM-DD) |
| Platform | Where it was posted |
| Post ID | Joins back to Content Calendar |
| URL | Public link to the post |
| Views | View/impression count |
| Likes | Reactions |
| Comments | Comment count |
| Shares | Shares/reposts/saves |
| Notes | Free-form — why you think it worked or didn't |

## Tab 6: `Watchlist`

Reference-only roster of every account you monitor across platforms — the
human-readable companion to the machine-read watch lists (YouTube channels and
Reddit subs live in `config.json`; LinkedIn profiles in
`config/linkedin-watchlist.json`).

**Written by:** you, by hand
**Read by:** you (agents read the config files, not this tab — keep them in sync)

| Column | Meaning |
|---|---|
| Name | Creator or company name |
| Platform | YouTube / Instagram / LinkedIn / Reddit / X |
| Handle or ID | Public handle, profile slug, or channel ID |
| Lane | Which of your content lanes they map to |
| Notes | Why they're on the list, verification notes, etc. |

---

## Sanity check

After creating the sheet, run the scout once in scraper mode (or the mock
pipeline, ONBOARDING.md Step 6). If a tab name is misspelled the run logs a
Sheets error for that tab and drops the rows into `output/` as JSON — fix the
tab name and paste the rows in manually.
