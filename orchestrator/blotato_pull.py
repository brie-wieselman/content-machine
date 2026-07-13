#!/usr/bin/env python3
"""Scheduler post-engagement adapter (Blotato backend) — the engagement
source for the weekly analyst.

THE GAP THIS CLOSES: attribution.py's payment/email adapters cover revenue
and list growth, but neither supplies real per-post engagement — without
this, `top_posts` in the weekly report only ever came from the manual
analytics-inbox fallback. The scheduler posts everything this engine
publishes, so its own analytics cover every connected platform uniformly —
no scrapers, no extra keys beyond the one you already have for publishing.

Contract (matches attribution.py's adapter pattern):
    blotato_pull(window_days=7) -> (data|None, note)

ENDPOINT:
    GET https://backend.blotato.com/v2/analytics
    → {"items": [{id, content, createdAt, platform, postUrl, mediaUrls,
                  latestMetrics: {fetchedAt, metrics: {viewsCount, likesCount,
                  commentsCount, sharesCount, savesCount, reachCount,
                  interactionsSum, ...}},        # metrics are STRING numbers
                  metricsHistory: [...]}]}
    (`/v2/posts` exists but carries NO metrics — id/platform/text/state only.)

Credentials: SCHEDULER_API_KEY from the environment or the repo-root .env.
If config/config.json declares scheduler.blotato_account_ids, results are
filtered to those platforms so a shared key can't leak another project's
numbers into your report.
"""
import json
import os
import urllib.request
from datetime import datetime, timedelta, timezone

ORCH = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(ORCH)
ENV_FILE = os.path.join(ROOT, ".env")
CONFIG_FILE = os.path.join(ROOT, "config", "config.json")


def _env(key):
    v = os.environ.get(key, "").strip()
    if v:
        return v
    try:
        with open(ENV_FILE) as f:
            for line in f:
                if line.strip().startswith(key + "="):
                    return line.split("=", 1)[1].strip()
    except OSError:
        pass
    return ""


def _configured_platforms():
    """Platform names declared in config.scheduler.blotato_account_ids.
    Empty set = no filter (report on everything the key can see)."""
    try:
        with open(CONFIG_FILE) as f:
            cfg = json.load(f)
    except (OSError, ValueError):
        return set()
    ids = (cfg.get("scheduler") or {}).get("blotato_account_ids") or {}
    return {p.lower() for p in ids if not p.startswith("_")}


def _get(path, key, timeout=30):
    req = urllib.request.Request(
        "https://backend.blotato.com" + path,
        headers={"blotato-api-key": key, "accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def _num(metrics, *keys):
    """Metrics arrive as STRINGS ("301"). Tolerant int cast."""
    for k in keys:
        v = metrics.get(k)
        try:
            if v is not None and str(v).strip() != "":
                return int(float(v))
        except (ValueError, TypeError):
            continue
    return 0


def blotato_pull(window_days=7):
    key = _env("SCHEDULER_API_KEY")
    if not key:
        return None, "Scheduler: no SCHEDULER_API_KEY in the env file — skipped."

    try:
        j = _get("/v2/analytics?limit=100", key)
    except Exception as e:  # noqa: BLE001
        return None, f"Scheduler: /v2/analytics unreachable ({str(e)[:80]}) — skipped."
    raw = j.get("items") or []
    if not raw:
        return None, "Scheduler: reachable but /v2/analytics returned no items — skipped."

    platforms = _configured_platforms()
    since = datetime.now(timezone.utc) - timedelta(days=window_days)
    posts = []
    for p in raw:
        platform = str(p.get("platform") or "?")
        if platforms and platform.lower() not in platforms:
            continue
        created = str(p.get("createdAt") or "")
        try:
            when = datetime.fromisoformat(created.replace("Z", "+00:00"))
            if when.tzinfo is None:
                when = when.replace(tzinfo=timezone.utc)
        except ValueError:
            when = datetime.now(timezone.utc)
        if when < since:
            continue
        metrics = ((p.get("latestMetrics") or {}).get("metrics")) or {}
        views = _num(metrics, "viewsCount", "impressionsCount", "reachCount")
        likes = _num(metrics, "likesCount")
        comments = _num(metrics, "commentsCount")
        shares = _num(metrics, "sharesCount", "repostsCount")
        saves = _num(metrics, "savesCount")
        text = str(p.get("content") or "")
        posts.append({
            "title": text.split("\n")[0][:120] or "(untitled post)",
            "platform": platform,
            "views": views,
            "engagements": likes + comments * 5 + shares * 3 + saves * 3,  # comments/shares/saves weighted above likes
            "likes": likes, "comments": comments, "shares": shares, "saves": saves,
            "url": str(p.get("postUrl") or ""),
        })

    if not posts:
        return ({"top_posts": [], "engagement": {"posts": 0}, "signals": []},
                f"Scheduler: OK — no analytics rows in the last {window_days}d window.")

    posts.sort(key=lambda x: x["engagements"], reverse=True)
    totals = {
        "posts": len(posts),
        "views": sum(p["views"] for p in posts),
        "likes": sum(p["likes"] for p in posts),
        "comments": sum(p["comments"] for p in posts),
        "shares": sum(p["shares"] for p in posts),
        "saves": sum(p["saves"] for p in posts),
    }
    # Engagement-lift signal for the analyst's experiment-spawn thresholds
    # (same shape the manual inbox supplies).
    signals = []
    if len(posts) >= 3:
        avg = sum(p["engagements"] for p in posts) / len(posts) or 1
        best = posts[0]
        lift = int(round((best["engagements"] / avg - 1) * 100))
        if lift > 0:
            signals.append({
                "name": f"top-post-lift-{best['platform']}",
                "engagement_lift_pct": lift,
                "hypothesis": f"'{best['title'][:60]}' outperformed the {window_days}d average by {lift}% on {best['platform']} — more of this angle/format.",
                "platform": best["platform"],
                "evidence": f"{best['engagements']} vs avg {int(avg)} engagements",
            })

    data = {"top_posts": posts[:10], "engagement": totals, "signals": signals}
    return data, (
        f"Scheduler: OK — {totals['posts']} analyzed post(s) in the last {window_days}d, "
        f"{totals['views']} views / {totals['likes']} likes / {totals['comments']} comments / {totals['saves']} saves."
    )


if __name__ == "__main__":
    data, note = blotato_pull()
    print(note)
    if data:
        print(json.dumps(data, indent=2)[:2500])
