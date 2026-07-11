# Example: a weekly system-audit skill

One of the most valuable pieces of this system isn't a pipeline stage — it's a
**structural self-audit that runs alongside everything**, because of a hard
lesson:

> The pipeline ran for weeks reporting success on every job while the actual
> output quietly degraded. When we finally dug in, it wasn't one bug — it was
> four stacked, silent ones, and none was the cause we suspected. A prompt was
> truncating the brand rules. A grading step had been a no-op for three weeks
> (unknown command, exit 0). A transport bug. A bypassed content gate.
>
> The lesson: **automation can report success while being completely wrong.**
> Green checkmarks and "no errors" don't mean the system is doing what you think.

So the audit doesn't just check "did the job run." It checks whether the
system's *actual state* is still coherent with its own rules. Generalized
checklist you can adapt:

## Audit checklist

### 1. Output queue health
- What's scheduled for the next N days? Flag gaps (days with nothing).
- Flag anything missing a required element (CTA, tag, disclosure).
- Flag near-duplicate content within a window.

### 2. Data freshness
- For any tracker/log the system depends on: flag rows that are stale
  (e.g. past a deadline with no data filled in).

### 3. Resource/inventory health
- Flag any pool running low (templates, hooks, prompts, credits).
- Flag anything marked a "winner" that hasn't been reused/scaled yet.

### 4. Redundancy check
- List all skills/agents; flag any two whose descriptions overlap heavily.
  Recommend merge or retire.

### 5. Config/rule consistency
- Flag any referenced file that's linked but missing on disk.
- Flag any locked rule that contradicts another locked rule.

### 6. Credits / external quotas
- Flag unknown balances; prompt to check before they run out mid-run.

### 7. Automation inventory (the silent-death check)
- List every scheduled job + its cadence.
- Cross-check against live run history. Flag any job with no useful output in
  2+ weeks as a RETIREMENT candidate — name it and why.
- If output can't be confirmed, mark "unverified — investigate" rather than
  asserting it's dead.

## Output format
1. One paragraph: overall health (green / yellow / red).
2. Numbered action list — max 5 items, ranked by impact.
3. "Leave alone" list — what's working, don't touch.
4. Retirement candidates — or "none."

The point: a periodic audit **separate from the pipeline itself**, checking for
silent no-ops, config contradictions, and drift. Almost nobody running agentic
automation has built this — and it's the thing that catches the failures your
green checkmarks are hiding.
