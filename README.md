# Content Machine

An autonomous content-operations pipeline for a solo creator — with a hard human
approval gate. It finds what's trending, drafts content in a defined brand voice,
grades its own drafts, produces video, and queues everything for scheduling. It never
publishes anything without an explicit human "go."

Built agent-by-agent by a non-traditional developer (a clinician who learned to build
by building). Published as a reference architecture — the ideas and the shape, not a
turnkey product.

> **Note on scope.** This is a *reference implementation*, not a plug-and-play app.
> It documents a working private system. You'll need to supply your own API keys,
> your own brand-voice spec, and your own scheduling accounts. See
> [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for how every part fits together.

## The one design principle everything is built around

**The machine does the labor. The human keeps the judgment.**

Every automated system that posts to an audience without a human in the loop is a
liability. This one is architected so that *rendering is not publishing* — those are
always two separate steps, separated by a person's eyes. One single file is the only
thing permitted to publish, and it only runs on an explicit approval reply.

## Architecture at a glance

Nine sequential stages, two parallel lanes, and a reliability layer that runs
alongside everything:

1. **Orchestration** — one scheduled entry point runs the whole chain
2. **Trend scout** — finds breakout topics across platforms
3. **Brand voice context** — loads the voice spec into every prompt
4. **Content generation** — writes posts, scripts, visual briefs
5. **Quality gate** — grades each draft against the voice spec
6. **Video production** — routes scripts to avatar / voiceover / thumbnail engines
7. **Two-gate approval** — render first, publish only on human reply
8. **Scheduler** — the *only* file allowed to publish
9. **Reporting & analytics** — daily brief, weekly performance read

**Parallel lanes:** a long-form blog publisher and a digital-product pipeline, both
approval-gated.
**Reliability layer:** a dead-man's switch on silent failures + a weekly structural
self-audit for drift.

See the full walkthrough in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## What this repo is NOT

- Not a hosted SaaS. There's no signup, no multi-tenant anything.
- Not a copy of the private production system — brand-specific content, credentials,
  and proprietary voice rules are deliberately excluded.
- Not maintained as a supported product. Issues welcome; guarantees, no.

## Setup (high level)

1. `cp .env.example .env` and fill in your own keys.
2. Provide your own brand-voice spec (see the voice-fingerprint method — separate repo).
3. Run the orchestrator in mock mode first to prove the plumbing with no credentials.

## License

MIT — see [`LICENSE`](LICENSE). Use it, learn from it, build your own.
