#!/usr/bin/env python3
"""Conversion attribution for the weekly analyst.

Design: each adapter activates only when its credential exists; a missing
key = skipped with a note, never an error. If NO real source is reachable,
collect() falls back to the manual inbox (orchestrator/analytics-inbox.json)
and says so LOUDLY so the weekly report shows the fallback happened.
ORCH_MOCK=1 short-circuits to the mock analytics file, no network.

Adapters shipped:
- STRIPE (payments) — PRIMARY conversion source when STRIPE_API_KEY is set.
  Use a RESTRICTED read-only key (read permission on Subscriptions/Customers
  only). Counts new subscriptions created in the window; if your checkout
  persists utm_campaign into subscription metadata, per-campaign attribution
  lights up automatically with zero changes here.
- EMAIL PLATFORM (list growth) — activates when EMAIL_PLATFORM_API_KEY is
  set. Point EMAIL_PLATFORM_SUBSCRIBERS_URL at your provider's subscriber
  endpoint (any key-auth REST API that returns a total works); the delta is
  computed between weekly snapshots stored in
  orchestrator/attribution-state.json. Adapt the parsing in
  email_platform_pull() to your provider.
- SCHEDULER (engagement) — see blotato_pull.py; supplies per-post
  performance across every connected platform.

Credentials come from the environment first, then the repo-root .env file.
"""
import base64
import json
import os
import urllib.request
from datetime import date, datetime, timedelta

ORCH = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(ORCH)
ENV_FILE = os.path.join(ROOT, ".env")
STATE_FILE = os.path.join(ORCH, "attribution-state.json")
INBOX = os.path.join(ORCH, "analytics-inbox.json")
MOCK_INBOX = os.path.join(ORCH, "mocks-data", "analytics.mock.json")
MOCK = os.environ.get("ORCH_MOCK") == "1"


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


def _get(url, headers, timeout=30):
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def _load(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


# ---------------------------------------------------------------------------
# STRIPE — primary. New paid subscriptions in the window, plus a campaign
# split when subscription metadata carries utm_campaign.
# ---------------------------------------------------------------------------
def stripe_pull(window_days=7):
    key = _env("STRIPE_API_KEY")
    if not key:
        return None, "Stripe: no STRIPE_API_KEY in the env file — skipped (see orchestrator/attribution.py header for the one-key setup)."
    # THE CONVERSION EVENT IS A NEW PAID SUBSCRIPTION. Subscriptions CREATED
    # in the window are counted as conversions. metadata.utm_campaign is read
    # for the campaign split — if your checkout doesn't persist it yet, totals
    # are still real and the split simply stays empty.
    since = int((datetime.now() - timedelta(days=window_days)).timestamp())
    auth = {"Authorization": "Bearer " + key}
    new_subs, by_campaign = 0, {}
    url = ("https://api.stripe.com/v1/subscriptions?status=all&created[gte]=%d&limit=100" % since)
    guard = 0
    while url and guard < 10:  # pagination guard
        page = _get(url, auth)
        for sub in page.get("data", []):
            new_subs += 1  # any subscription object created in the window = a new paid signup
            camp = (sub.get("metadata") or {}).get("utm_campaign", "")
            if camp:
                by_campaign[camp] = by_campaign.get(camp, 0) + 1
        if page.get("has_more") and page.get("data"):
            url = ("https://api.stripe.com/v1/subscriptions?status=all&created[gte]=%d&limit=100&starting_after=%s"
                   % (since, page["data"][-1]["id"]))
        else:
            url = None
        guard += 1
    out = {"conversions_total": new_subs, "conversion_metric": "new paid subscriptions"}
    if by_campaign:
        out["utm_campaigns"] = [{"campaign": c, "conversions": n} for c, n in sorted(by_campaign.items())]
    return out, "Stripe: OK — %d new paid subscription(s) in the last %d days%s." % (
        new_subs, window_days,
        "" if by_campaign else "; no utm_campaign metadata, so no campaign split — persist utm_campaign at checkout to enable it")


# ---------------------------------------------------------------------------
# EMAIL PLATFORM — subscriber total; delta computed between weekly snapshots.
# Generic key-auth adapter: point EMAIL_PLATFORM_SUBSCRIBERS_URL at your
# provider's subscriber-count endpoint and adjust the meta parsing if needed.
# ---------------------------------------------------------------------------
def email_platform_pull():
    key = _env("EMAIL_PLATFORM_API_KEY")
    if not key:
        return None, "Email platform: no EMAIL_PLATFORM_API_KEY — skipped (subscriber delta comes from the inbox or stays blank)."
    url = _env("EMAIL_PLATFORM_SUBSCRIBERS_URL")
    if not url:
        return None, "Email platform: EMAIL_PLATFORM_API_KEY is set but EMAIL_PLATFORM_SUBSCRIBERS_URL is not — skipped."
    # Basic auth with the key as username + empty password is the most common
    # pattern for simple email-platform REST APIs; adjust for your provider.
    auth = {"Authorization": "Basic " + base64.b64encode((key + ":").encode()).decode(),
            "User-Agent": "content-machine attribution"}
    page = _get(url, auth)
    meta = page.get("meta") or {}
    total = meta.get("total_items")
    if total is None:
        total = meta.get("total_count") or meta.get("total") or page.get("total")
    if total is None:
        return None, "Email platform: reachable but no total count in the response — adapt email_platform_pull() to your provider."
    state = _load(STATE_FILE, {})
    prev = state.get("email_total")
    state["email_total"] = total
    state["email_total_at"] = date.today().isoformat()
    with open(STATE_FILE, "w") as f:
        json.dump(state, f, indent=2)
    out = {"subscribers": {"start": prev if prev is not None else "?", "end": total,
                           "delta": ("%+d" % (total - prev)) if prev is not None else "first snapshot"}}
    return out, "Email platform: OK — %s subscribers (delta vs last snapshot: %s)." % (total, out["subscribers"]["delta"])


# ---------------------------------------------------------------------------
def collect(window_days=7):
    """Merged analytics dict for the analyst. Real sources win; the manual
    inbox augments (manual campaign rows survive unless a real source names
    the same campaign) and is the full fallback when no real source is
    reachable."""
    inbox = _load(MOCK_INBOX if MOCK else INBOX, {})
    if MOCK:
        return {**inbox, "sources": ["mock"], "fallback_used": False, "source_notes": ["ORCH_MOCK=1 — mock analytics."]}

    merged = dict(inbox)  # inbox supplies manual campaign rows; real sources override
    notes, sources = [], []
    # The scheduler adapter supplies real per-post engagement across every
    # connected platform — top_posts/signals no longer depend on the manual
    # inbox. Stripe stays primary for revenue; the scheduler supplies the
    # engagement layer.
    try:
        from blotato_pull import blotato_pull  # sibling module, same orchestrator dir
    except ImportError:
        import sys as _s
        _s.path.insert(0, ORCH)
        from blotato_pull import blotato_pull
    for name, fn in (("stripe", lambda: stripe_pull(window_days)),
                     ("email-platform", email_platform_pull),
                     ("scheduler", lambda: blotato_pull(window_days))):
        try:
            data, note = fn()
        except Exception as e:  # noqa: BLE001 — a down source must not kill the report
            data, note = None, "%s: UNREACHABLE this week (%s) — skipped." % (name, str(e)[:120])
        notes.append(note)
        if data:
            sources.append(name)
            for k, v in data.items():
                if k == "utm_campaigns" and merged.get("utm_campaigns"):
                    # real campaign rows override manual rows with the same name
                    manual = {c["campaign"]: c for c in merged["utm_campaigns"]}
                    for row in v:
                        manual[row["campaign"]] = row
                    merged["utm_campaigns"] = sorted(manual.values(), key=lambda c: c["campaign"])
                else:
                    merged[k] = v

    fallback = not sources
    if fallback:
        notes.append("⚠️ FALLBACK: no real attribution source was reachable this week — "
                     "this report uses the manual inbox (orchestrator/analytics-inbox.json) only.")
    merged["sources"] = sources or ["manual-inbox"]
    merged["fallback_used"] = fallback
    merged["source_notes"] = notes
    return merged


if __name__ == "__main__":
    print(json.dumps(collect(), indent=2))
