# Code walkthrough

This reference repo doesn't ship the full production system — it ships the
**three files that carry the interesting ideas**, genericized. The individual
content agents (scout, writer, video router, etc.) are represented in the
registry but not all included, because their implementations are brand-specific.
What's here is the architecture and the two hard-won lessons.

## `orchestrator/run.py` — the control layer

One entry point runs every agent as a scheduled batch job. Nothing runs
continuously. The design worth copying:

- **Wrap, don't rewrite.** The proven pipeline stays the sole content entry
  point; granular per-agent entries exist only for manual runs and experiments.
- **Locks** prevent overlapping runs; stale locks (dead PID) auto-clear.
- **State is reloaded *after* each subprocess**, never snapshotted before — a
  child process may write state while it runs, and a pre-spawn snapshot silently
  clobbers those writes. (That was a real bug.)
- **Graduation is report-only.** An agent can become *eligible* to run
  unattended, but `check_graduation()` only logs it — a human flips the flag in
  `state.json`. The orchestrator never promotes anything itself. This is the
  entire trust model: the machine earns trust; only a person grants it.
- **Mock mode** (`ORCH_MOCK=1`) dry-runs the whole engine with zero credentials
  and zero network — so you can prove the plumbing before wiring real keys.

## `agents/brand-context.js` — the drift-fix (read the header comment)

This is the most useful file in the repo. It exists because of a real bug that
took weeks to find:

> The writer sent a blind `slice(0, 22000)` of a growing brand-canon file to the
> model. The file outgrew the slice, the actual voice rules fell *past* the cut,
> and the model never saw them. Every new rule added near the top pushed more
> voice rules out of the window — **so adding rules made the output worse.**

The fix: **extract by heading, never by character count.** The generalized
lesson — never `slice(0, N)` a growing document into a prompt — applies to any
LLM system that stuffs context. It also pairs naturally with a *voice
fingerprint* (see the companion [voiceprint](https://github.com/brie-wieselman/voiceprint)
skill): checkable voice rules extracted from real writing instead of adjectives.

It also carries the **on-topic gate** — a deliberately conservative guardrail
(unknown topics are rejected) that exists because a batch path once bypassed the
topic check and generated wildly off-brand content three runs in a row. Swap the
placeholder keyword lists for your own brand's vocabulary.

## `orchestrator/agents.example.json` — the registry

The whole system at a glance: every agent, what it does, and the exact command
it wraps. Note that `publisher-queue` is the *only* path that can publish, and it
only acts on an explicit human approval reply. Copy this to `agents.json` and
point the commands at your own implementations.

---

**The two ideas to steal from this repo:** (1) a human-approval gate that the
system can never bypass, and (2) extract-by-structure, never slice-by-length,
when feeding a growing canon to a model.
