# Content Machine

An autonomous content-operations pipeline for a solo creator — with a hard human
approval gate. It finds topics, drafts articles and social copy in a defined brand
voice, grades its own drafts, builds Canva visual briefs from your templates, and
queues everything for scheduling. In its default mode it never publishes anything
without an explicit human "go."

Built agent-by-agent by a non-traditional developer (a clinician who learned to build
by building). Published as a reference architecture — the ideas and the shape, not a
turnkey product.

> **Turnkey, with setup.** You can stand this up for your own brand: plug in your
> voice fingerprint, your visual guide, your own Canva templates, pick your platforms
> and schedule, and choose approve-before-post or full auto. It produces **articles,
> Canva posts, and social copy in your voice** — no video, no voice cloning. Follow
> **[`ONBOARDING.md`](ONBOARDING.md)** to set it up (~60–90 min). You bring your own
> API keys and accounts; everything brand-specific lives in [`config/`](config/).

## The one design principle everything is built around

**The machine does the labor. The human keeps the judgment.**

Every automated system that posts to an audience without a human in the loop is a
liability. This one is architected so that *rendering is not publishing* — those are
always two separate steps, separated by a person's eyes. One single file is the only
thing permitted to publish, and it only runs on an explicit approval reply.

## Architecture at a glance

Eight sequential stages, a parallel article lane, and a reliability layer that runs
alongside everything:

1. **Orchestration** — one scheduled entry point runs the whole chain
2. **Topics** — your declared topics by default; optional trend scout with your own API keys
3. **Brand voice context** — loads your voice fingerprint + content rules into every prompt
4. **Content generation** — writes articles and per-platform social copy
5. **Quality gate** — grades each draft against the voice spec; weak drafts rewritten or rejected
6. **Visuals** — Canva design briefs from your own brand templates
7. **Approval → scheduling** — approve-per-item by email, or full auto once you trust it
8. **Reporting & analytics** — one daily digest, one weekly performance read

**Parallel lane:** a long-form article writer that outputs publish-anywhere files.
**Reliability layer:** a dead-man's switch on silent failures + a periodic structural
self-audit for drift.

See the full walkthrough in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## What this repo is NOT

- Not a hosted SaaS. There's no signup, no multi-tenant anything.
- Not a copy of the private production system — brand-specific content, credentials,
  and proprietary voice rules are deliberately excluded.
- Not maintained as a supported product. Issues welcome; guarantees, no.

## Setup

Full step-by-step in **[`ONBOARDING.md`](ONBOARDING.md)**. The short version:
1. `git clone` + `npm install`
2. Build your voice fingerprint with the [voiceprint](https://github.com/brie-wieselman/voiceprint) skill → `config/voice-fingerprint.md`
3. `cp config/config.example.json config/config.json` and fill in your brand, platforms, Canva template IDs, schedule, and approve-vs-auto mode
4. Copy the Google Sheet template + add your keys to `.env`
5. `ORCH_MOCK=1 python3 orchestrator/run.py pipeline` — dry-run with zero credentials to prove the wiring
6. `node pipeline.js --once` — first real run (emails you for approval by default)

## License

MIT — see [`LICENSE`](LICENSE). Use it, learn from it, build your own.
