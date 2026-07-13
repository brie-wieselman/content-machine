#!/usr/bin/env python3
"""Deterministic per-agent mocks for ORCH_MOCK=1 dry-runs.

Each mock writes plausible artifacts into orchestrator/mockrun/ so the full
engine (orchestration, logging, state, analyst, experiments) can be
exercised end-to-end with zero credentials and zero network. Mocks never
touch the real approval queue, the scheduler, sheets, or email.

The sample content below uses a neutral placeholder niche ("urban
gardening") — swap nothing; it exists only to prove the plumbing.
"""
import json
import os
import sys
from datetime import date

ORCH = os.path.dirname(os.path.abspath(__file__))
SANDBOX = os.path.join(ORCH, "mockrun")
os.makedirs(SANDBOX, exist_ok=True)
TODAY = date.today().isoformat()


def w(name, text):
    p = os.path.join(SANDBOX, name)
    with open(p, "w") as f:
        f.write(text)
    print("mock artifact -> %s" % p)


def scout():
    w("outliers-%s.json" % TODAY, json.dumps([
        {"title": "Why balcony tomatoes fail by July", "score": 412, "creator": "@examplegardener"},
        {"title": "The soil test every renter skips", "score": 335, "creator": "@anothercreator"},
    ], indent=2))


def maker():
    w("agent3-%s-mock-package.md" % TODAY,
      "# Content Package — Why balcony tomatoes fail by July (MOCK)\n\n- **Generation mode:** Claude API\n\n"
      "## VERSION 1\n**Hook (9/10):** Your tomatoes died before August — and it wasn't the heat.\n")


def grader():
    w("agent3-%s-mock-package.grade.txt" % TODAY, "Score: 9/10\nVerdict: ship\nTop 3 fixes:\n1. -\n2. -\n3. -\n")


def publisher_queue():
    w("queue-%s.json" % TODAY, json.dumps({
        "status": "awaiting-approval",
        "post": "mock package v1", "platform": "instagram",
        "link": "https://example.com/?utm_source=agent&utm_medium=instagram&utm_campaign=maker",
        "note": "publisher is approval-queue mode — nothing publishes in mock or otherwise without the operator's reply",
    }, indent=2))


def pipeline():
    scout(); maker(); grader(); publisher_queue()


MOCKS = {"scout": scout, "maker": maker, "grader": grader,
         "publisher-queue": publisher_queue, "pipeline": pipeline,
         "brand-voice": lambda: w("brandvoice-%s.txt" % TODAY, "mock brand voice refresh\n")}

if __name__ == "__main__":
    agent = sys.argv[1] if len(sys.argv) > 1 else ""
    fn = MOCKS.get(agent)
    if not fn:
        # analyst / experiments run their REAL code in mock mode (they honor
        # ORCH_MOCK internally) — they should not be routed here.
        raise SystemExit("no mock for %r — this agent runs its real code under ORCH_MOCK" % agent)
    fn()
    print("MOCK %s complete" % agent)
