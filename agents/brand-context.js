'use strict';
/* ============================================================================
 * BRAND CONTEXT BUILDER — shared by every agent that generates on-voice copy
 *
 * WHY THIS EXISTS (a real drift bug worth learning from): the writer used to
 * send `brand.slice(0, 22000)` to the model — a blind character-slice of a
 * large brand-canon file. But the file had grown to ~88k chars, and the
 * voice/content sections started around char ~29k. So the model received the
 * top of the file (git hygiene, visual standards, template tables) and NEVER
 * received the actual BRAND VOICE and CONTENT RULES. Worse: every new rule
 * added near the TOP of the canon pushed more voice rules PAST the slice —
 * so adding rules made the output WORSE. Voice drift got steadily worse while
 * everyone believed "the rules are in the file."
 *
 * THE FIX (two parts):
 *  1. Split the canon by concern so the voice/content rules live in their own
 *     file, passed in here as `contentDoc`.
 *  2. Extract sections BY HEADING, never by slicing (below). Even if the doc
 *     grows unrelated sections, or a caller mistakenly passes the whole raw
 *     canon again, heading-based extraction keeps only the rules that matter.
 *
 * The lesson, generalized: never `slice(0, N)` a growing document into a
 * prompt. Extract by structure. A fixed character budget silently drops the
 * most important content the moment the document outgrows it.
 * ========================================================================== */

const fs = require('fs');
const path = require('path');

// Resolves to <repo root>/docs/VOICE_AND_CONTENT_RULES.md regardless of which
// agent's __dirname required this module (agents/ is always one level below
// the repo root).
const CONTENT_DOC_PATH = path.join(path.resolve(__dirname, '..'), 'docs', 'VOICE_AND_CONTENT_RULES.md');
function loadContentDoc() {
  try { return fs.readFileSync(CONTENT_DOC_PATH, 'utf8'); } catch (_) { return ''; }
}

// Headings whose sections carry the voice/content canon, in priority order.
// Matched as a case-insensitive PREFIX of each "## " heading, so date suffixes
// and annotations in the heading don't break extraction. Edit these to match
// the section titles in YOUR own voice/content doc.
const CONTENT_SECTION_PREFIXES = [
  'WHO I AM',
  'MY AUDIENCE',
  'BRAND VOICE',
  'CONTENT RULES',
  'STRATEGY LAYER',
  'HOOK RESTRUCTURING RULE',
  'PLATFORM RULES',
  'BIOGRAPHY CANON',
  'ACCOUNT ROUTING RULES',
];

/**
 * Extract the voice/content sections out of a doc by heading (order-
 * independent). Returns '' if extraction looks broken (fewer than 3 sections
 * matched), so callers can fall back to sending the raw text instead of
 * silently sending a near-empty canon.
 */
function extractContentSections(docText) {
  const parts = (docText || '').split(/^(?=## )/m);
  const picked = [];
  for (const prefix of CONTENT_SECTION_PREFIXES) {
    const sec = parts.find((p) => p.replace(/^##\s*/, '').toUpperCase().startsWith(prefix.toUpperCase()));
    if (sec && !picked.includes(sec)) picked.push(sec);
  }
  if (picked.length < 3) return '';
  return picked.join('\n');
}

/**
 * Build the full brand context string for content-writing prompts:
 * voice fingerprint first (it drives style), then an optional hook library,
 * then the curated voice/content canon. Pass `contentDoc` as the text of your
 * voice/content rules doc (use loadContentDoc() to read it). `voice`/`hooks`
 * may be ''.
 *
 * Tip: `voice` pairs naturally with a voice-fingerprint file — a set of
 * checkable, evidence-derived voice rules extracted from real writing rather
 * than described in adjectives.
 */
function buildBrandContext({ voice, hooks, contentDoc, rawCanon }) {
  const source = contentDoc || rawCanon; // rawCanon kept as a legacy alias
  const curated = extractContentSections(source);
  const rules = curated
    ? `=== BRAND / CONTENT RULES (voice + content canon) ===\n${curated}`
    : `=== BRAND / OPS RULES ===\n${source || ''}`; // legacy fallback if headings ever change
  return (voice ? `=== BRAND VOICE FINGERPRINT (match this voice exactly) ===\n${voice}\n\n` : '')
    + (hooks ? `=== HOOK FRAMEWORK LIBRARY (write the hook FIRST; label which framework each hook uses; never the same framework twice in a row) ===\n${hooks}\n\n` : '')
    + rules;
}

// ---------------------------------------------------------------------------
// ON-TOPIC GATE — a cheap guardrail that keeps generated content on-brand.
//
// This exists because a batch-expansion path once bypassed the topic check and
// generated wildly off-brand content (a "free online courses from top
// universities" listicle) three runs in a row. The gate is deliberately
// conservative: unknown topics are REJECTED, and a human-written manual brief
// bypasses it. Replace the two keyword lists below with YOUR brand's on-topic
// and off-topic vocabularies (load them from config in a real deployment).
// ---------------------------------------------------------------------------
const ON_TOPIC_RE = new RegExp(
  '\\b(' + [
    // >>> replace with your brand's core topics <<<
    'example-topic-a', 'example-topic-b', 'example-topic-c',
  ].join('|') + ')\\b', 'i');
const OFF_TOPIC_RE = new RegExp(
  '\\b(' + [
    // >>> replace with topics that keep leaking in but are off-brand <<<
    'free course', 'unrelated-viral-topic', 'generic-productivity-tip',
  ].join('|') + ')\\b', 'i');
function isOnTopic(topic) {
  const t = String(topic || '');
  if (OFF_TOPIC_RE.test(t)) return false;
  if (ON_TOPIC_RE.test(t)) return true;
  return false; // unknown = reject; a human-written manual brief bypasses this gate
}

module.exports = { buildBrandContext, extractContentSections, isOnTopic, CONTENT_SECTION_PREFIXES, loadContentDoc, CONTENT_DOC_PATH };
