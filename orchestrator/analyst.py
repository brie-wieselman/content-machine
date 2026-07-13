#!/usr/bin/env python3
"""Sunday Analyst — the engine's one weekly readout.

Reads: orchestrator run logs, the writer/pipeline logs, and real attribution
(attribution.py: payments primary, email platform + scheduler engagement when
keyed). The manual inbox (orchestrator/analytics-inbox.json — a plain JSON
file you can drop numbers into by hand) augments and is the loud fallback.
ORCH_MOCK=1 uses orchestrator/mocks-data/analytics.mock.json instead.

Writes: orchestrator/reports/analyst-<date>.md — a 5-minute plain-language
report: what posted, what performed, UTM-attributed conversions, subscriber
delta, and EXACTLY ONE recommended adjustment. One adjustment is the
discipline: a report that recommends five things recommends nothing.
Emails it via the existing mailer (skipped in mock mode).

Also: scores any active experiment past its end date (verdict + retirement
per its own manifest) and drafts a spawn manifest into approval-queue/ when
a signal crosses the spawn thresholds. Drafting is the ceiling of its power —
instantiation always waits for the operator's approval.
"""
import json
import os
import re
import subprocess
import sys
from datetime import date, datetime, timedelta

ORCH = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(ORCH)
REPORTS = os.path.join(ORCH, "reports")
MOCK = os.environ.get("ORCH_MOCK") == "1"
INBOX = os.path.join(ORCH, "mocks-data", "analytics.mock.json") if MOCK else os.path.join(ORCH, "analytics-inbox.json")
CONFIG = os.path.join(ROOT, "config", "config.json")

sys.path.insert(0, ORCH)
import attribution  # noqa: E402
import experiments  # noqa: E402


def _load(p, d):
    try:
        with open(p) as f:
            return json.load(f)
    except (OSError, ValueError):
        return d


def week_posts():
    """What went out this week — from the approval log (the only local ground
    truth of scheduled posts) plus this week's package files."""
    posts = []
    log = os.path.join(ROOT, "logs", "approval-log.txt")
    cutoff = (datetime.now() - timedelta(days=7)).isoformat()
    try:
        with open(log, errors="replace") as f:
            for line in f:
                m = re.match(r"\[([0-9T:.\-]+)Z?\].*(schedul|approved|posted)", line, re.I)
                if m and m.group(1) >= cutoff:
                    posts.append(line.strip()[:180])
    except OSError:
        pass
    return posts[-40:]


def main():
    os.makedirs(REPORTS, exist_ok=True)
    # Real attribution by default (payments primary; email platform +
    # scheduler engagement when keyed); manual inbox augments and is the
    # loud fallback — see attribution.py.
    analytics = attribution.collect()
    cfg = _load(CONFIG, {})
    # Optional override in config.json: {"experiments": {"spawn_thresholds": {...}}}
    thresholds = (cfg.get("experiments") or {}).get(
        "spawn_thresholds", {"platform_engagement_lift_pct": 40, "campaign_conversions": 3})
    today = date.today().isoformat()
    posts = week_posts()

    # --- experiment scoring at/after day 14 ---
    exp_lines = []
    state = _load(os.path.join(ORCH, "state.json"), {})
    for e in list(state.get("experiments", {}).get("active", [])):
        if e.get("ends", "9999") <= today:
            result = experiments.score(e["id"], analytics)
            experiments.retire(e["id"], result)
            exp_lines.append("- Experiment **%s** ended: **%s** (%d conversions vs target %d). %s" % (
                result["id"], result["verdict"].upper(), result["conversions"], result["target"],
                "Moved to the graveyard with a post-mortem." if result["verdict"] == "loss"
                else "Decision file written — promoting it is your call."))
        else:
            exp_lines.append("- Experiment **%s** running (day %d of 14, %d/%d posts made)." % (
                e["id"], (date.today() - date.fromisoformat(e["started"])).days,
                e.get("posts_made", 0), e.get("post_quota", 0)))

    # --- spawn-signal check (draft only; never instantiates) ---
    spawn_note = ""
    active_n = len(_load(os.path.join(ORCH, "state.json"), {}).get("experiments", {}).get("active", []))
    for sig in analytics.get("signals", []):
        lift = sig.get("engagement_lift_pct", 0)
        if lift >= thresholds["platform_engagement_lift_pct"] and active_n < 2:
            path = experiments.draft_manifest({
                "name": sig["name"], "hypothesis": sig["hypothesis"],
                "evidence": sig.get("evidence", "engagement lift %d%%" % lift),
                "topic_focus": sig.get("topic_focus", ""), "platform": sig.get("platform", "instagram"),
                "hook_style": sig.get("hook_style", ""),
            })
            spawn_note = ("A signal crossed your threshold (%s, +%d%%), so I drafted an experiment "
                          "proposal to the approval queue: `%s`. Nothing runs unless you approve it."
                          % (sig["name"], lift, os.path.basename(path)))
            break  # one proposal max per week — keeps the queue calm

    # --- the ONE adjustment ---
    campaigns = analytics.get("utm_campaigns", [])
    signups_total = sum(c.get("conversions", 0) for c in campaigns)
    best = max(campaigns, key=lambda c: c.get("conversions", 0), default=None)
    new_subs = analytics.get("conversions_total")
    if best and best.get("conversions", 0) > 0:
        adjustment = ("Shift one weekly slot toward what's converting: campaign **%s** drove %d of %d "
                      "attributed conversions — give its topic/platform one extra post next week."
                      % (best["campaign"], best["conversions"], signups_total))
    elif new_subs == 0 and posts:
        adjustment = ("Real data, real signal: **0 conversions this week** (payments source). The content is "
                      "running but not converting — the highest-leverage move is the funnel, not more "
                      "posts. Check that your checkout persists utm_campaign so we can see WHICH content "
                      "converts.")
    elif posts:
        adjustment = ("Attribution is live but per-campaign splits aren't — persist utm_campaign at checkout "
                      "so next week's report can name which content drove the %s new signup(s)."
                      % (new_subs if new_subs is not None else "the"))
    else:
        adjustment = "Nothing posted this week — check that the scheduled pipeline ran (orchestrator/logs/)."

    sub = analytics.get("subscribers", {})
    conversions_line = ""
    if "conversions_total" in analytics:
        label = analytics.get("conversion_metric", "conversions")
        conversions_line = "- **Conversions this week (payments source, real): %s** (%s)" % (analytics["conversions_total"], label)
    report = "\n".join([
        "# Weekly engine report — %s" % today,
        "",
        "## Data sources this week",
        "- " + ", ".join(analytics.get("sources", ["?"])) +
        ("  \n- ⚠️ **MANUAL-INBOX FALLBACK was used — no real source was reachable.**"
         if analytics.get("fallback_used") else ""),
        "\n".join("- %s" % n for n in analytics.get("source_notes", [])),
        "",
        "## What posted (last 7 days)",
        ("- %d approval-log events; latest:\n" % len(posts)) + "\n".join("  - `%s`" % p for p in posts[-5:]) if posts else "- Nothing recorded in the approval log this week.",
        "",
        "## What performed",
        "\n".join("- **%s** on %s: %s views, %s engagements" % (r.get("title", "?"), r.get("platform", "?"), r.get("views", "?"), r.get("engagements", "?"))
                  for r in analytics.get("top_posts", [])) or "- No performance rows in the analytics inbox.",
        "",
        "## Conversions + subscribers",
        conversions_line,
        "\n".join("- campaign `%s`: %d conversions" % (c.get("campaign", "?"), c.get("conversions", 0)) for c in campaigns) or "- No per-campaign rows (persist utm_campaign at checkout to enable the split — totals above are real).",
        "- Subscribers: %s → %s (Δ %s)" % (sub.get("start", "?"), sub.get("end", "?"), sub.get("delta", "?")),
        "",
        "## Experiments",
        "\n".join(exp_lines) or "- None active.",
        "",
        "## The one adjustment",
        adjustment,
        ("\n## New experiment proposal\n" + spawn_note) if spawn_note else "",
    ])
    out = os.path.join(REPORTS, "analyst-%s.md" % today)
    with open(out, "w") as f:
        f.write(report + "\n")
    print("report -> %s" % out)

    report_to = (cfg.get("approval") or {}).get("approval_channel_email", "")
    if not MOCK and report_to:
        try:  # email via the existing node mailer (same sender identity as everything else)
            subprocess.run(["node", "-e",
                            "require('./agents/mailer').sendMail(process.env.TO,process.env.SUBJ,"
                            "require('fs').readFileSync(process.env.BODYF,'utf8')).then(()=>console.log('sent'))"],
                           cwd=ROOT, timeout=60, check=False,
                           env={**os.environ, "TO": report_to,
                                "SUBJ": "📈 Weekly engine report — %s" % today, "BODYF": out})
        except Exception as e:  # noqa: BLE001
            print("email send failed (report still on disk): %s" % e)
    elif not MOCK:
        print("no approval.approval_channel_email in config/config.json — report not emailed (still on disk).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
