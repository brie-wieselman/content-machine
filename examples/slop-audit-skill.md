# Example: a pre-publish "slop gate" skill

The pipeline can render a hundred posts and still ship garbage. The failures
aren't in the writing — they're in the **execution**: a caption running off the
slide, text sized too small to read on a phone, a voiceover that drifted flat,
or the single worst one —

> A carousel's **title slide** gets posted **by itself** on a platform that
> doesn't support carousels. The audience sees "Slide 1 of 7" — a title with no
> payload — and the whole post lands flat. Or a *middle* slide gets orphaned
> onto a text-first platform where it makes no sense without the other six.

A human catching this by hand means eyeballing every queued post before it goes
out. That doesn't scale, and the day you're busy is the day the sloppy one
ships. So this is the gate: **one automated pass that runs against what will
actually post — the rendered asset and the platform mapping — and holds
anything that fails, instead of letting it publish.**

The core principle, same as the rest of the system: **rendering is not
publishing.** A finished-looking asset is not a shippable one until it clears
the gate.

## How to run it

1. Pull the full scheduled queue (paginate — a partial pull is a failed audit).
2. For each item, run the 7 checks below against the **rendered file** (the
   actual image/video that posts) and the **platform mapping**.
3. Assign a verdict. **Hold** anything below ship — pause the schedule, don't
   delete it — so nothing auto-posts while it's being fixed.
4. Output a ranked report, worst first, plus a fix list.

## The 7 checks (each a hard gate)

**1. Font size & legibility.** Enforce a hard minimum size for body and titles
on your canvas (pick a floor and never go under it — split a slide instead of
shrinking text). Would it read on a phone at arm's length? If not, fail.

**2. Overflow & overlap.** No copy running off the edge, no text colliding with
other text, no text on a busy part of an image with no plate behind it. Check
the *rendered frame*, not the layout intent — pipelines overflow silently.

**3. Invisible text.** Near-invisible text (dark-on-dark, light-on-light)
**passes** automated checks because the characters exist in the markup. You have
to inspect the rendered pixels for contrast. Fail anything that disappears into
its background.

**4. Voiceover drift.** For any narrated video: the audio must read with warmth
and dynamic cadence, not flat monotone. TTS/voice models drift — regenerate
fresh and verify rather than trusting a cached file. Fail flat delivery, a
drifted voice, wrong engine, or an obvious mispronunciation.

**5. Platform fit — the carousel/single trap (highest-frequency failure).** Map
every asset to what the platform can actually show:

- Platforms that support carousels → post the **whole set**, never the title
  slide alone.
- Text-first / single-image platforms → a carousel must become a **standalone
  summary card** or the point must live fully in the caption. **Never** an
  orphan mid-carousel slide that's meaningless without the others.
- Broken/unsupported destinations → skip, don't post a degraded fallback.

Fail: a title slide posted as a single; a mid-carousel slide orphaned on a
single-image platform; a multi-slide point reduced to one slide that reads as
incomplete.

**6. Standing requirements.** Whatever your brand's non-negotiables are, check
them mechanically here: e.g. every video has a title card and captions; no flat
solid backgrounds if that's your rule; your link/handle present in the caption.

**7. Potency.** Run the copy through your virality/quality grader (hook carries
most of the weight). A post can be pixel-perfect and still be flat. And it must
be **self-contained**: a reader who sees only this asset, on this platform, gets
a complete thought — not a fragment of something they can't see.

## Verdict bands (per post)
- **Ship** — passes all 7. Leave scheduled.
- **Fix** — one or two cosmetic fails (size floor, missing link). Fix in place,
  re-check, then ship.
- **Hold** — any platform-fit fail, invisible text, voice drift, overflow, or
  a failing potency score. Pause the schedule so it can't auto-post. Never
  delete — hold and hand back the fix.

## Output format
A ranked table, worst first (post/platform · verdict · failed checks · fix),
ending with the tallies (**X ship / Y fix / Z hold**) and — the important part —
**the single most common failure across the batch**, so you can fix the
*pipeline* upstream instead of patching symptoms forever.

The point: the product you sell *is* the execution. This gate is what keeps a
rendering pipeline from quietly shipping slop the moment you're not watching —
and the "most common failure" line is what turns each audit into an upstream fix
instead of endless manual cleanup.
