# Architecture

Eight stages, one parallel lane, and a reliability layer that runs alongside
everything. The design principle underneath all of it: **the machine does the labor;
the operator keeps the judgment.**

## The stages

**1 · Orchestration** (`orchestrator/run.py`, `pipeline.js`)
The control layer. One command runs the whole chain on a schedule — nothing runs
continuously, nothing publishes on its own. Locks prevent overlapping runs; mock mode
(`ORCH_MOCK=1`) dry-runs the entire engine with zero credentials.

**2 · Topics** (`config/config.json`, optionally `agents/agent2-scout.js`)
Where content ideas come from. Default: your own declared topics + niche keywords —
no paid APIs required. Optional: the trend scout mines breakout content across
platforms using your own API keys, scoring outliers against each channel's own
average so a small channel's hit counts as much as a big one's.

**3 · Brand voice context** (`agents/brand-context.js`)
Before anything is written, the writer's prompt is assembled from your voice
fingerprint + your content rules — extracted **by section heading, never by character
slice**. That rule exists because of a real drift bug: a blind `slice(0, N)` silently
dropped the voice rules once the canon file outgrew the budget, and output degraded
for weeks behind green checkmarks.

**4 · Content generation** (`agents/agent3-writer.js`, `agents/aeo-weekly.js`)
Writes article drafts and per-platform social copy in the configured voice, saved as
review packages. Long-form articles land as markdown + HTML files you can publish
anywhere.

**5 · Quality gate** (`agents/quality-monitor.js`)
Every draft is graded against the voice spec before it can move forward — ship /
fix / reject thresholds, with one rewrite pass. The system critiques its own work
(the reflection pattern): the first draft has to earn its place. The gate also
watches for its own death — if grading silently stops happening, that's flagged.

**6 · Visuals** (`agents/agent3c-canva.js`)
Turns approved copy into Canva design briefs against **your own** saved brand
templates, guided by your brand visual guide.

**7 · Approval → scheduling** (`agents/approval-handler.js`, `agents/agent5-scheduler.js`)
The safety model. In `approve` mode (default), the engine emails you a review and
**nothing schedules until you reply** — `APPROVE-N`, per item. In `auto` mode, graded
content schedules itself. Either way there is exactly one chokepoint:
`agent5-scheduler.js` is the *only* file that can publish, and the approval handler
is the only thing that invokes it. Guarding one door beats guarding ten.

**8 · Reporting & analytics** (`agents/agent6b-daily-reporter.js`, `agents/agent7-analyst.js`, `orchestrator/analyst.py`)
One consolidated daily digest of everything the engine did, plus a weekly read on
what actually performed — ending in **exactly one recommended adjustment**, because a
report that recommends ten things recommends nothing.

## The parallel lane
**Articles** (`agents/aeo-weekly.js`) — long-form pieces on their own weekly cadence,
written to `output/articles/` as files. No website integration required; publish them
wherever you publish.

## The reliability layer (runs alongside everything)
- **Dead-man's switch** (`agents/alerts.js`) — if any stage fails, you get an email +
  a local notification + an on-disk alert file. Born from a morning when both alert
  channels failed silently at once.
- **Graduation, report-only** — an agent that consistently earns unedited approvals
  becomes *eligible* to run unattended, but the orchestrator only logs that; a human
  flips the flag in `state.json`. The machine earns trust; only a person grants it.
- **Self-audit** (see `examples/system-audit-skill.md`) — a periodic structural check
  for silent no-ops, contradicting rules, and drift, separate from the pipeline
  itself. Green checkmarks are not the same thing as correct behavior.
