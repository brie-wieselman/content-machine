#!/usr/bin/env node
/* ============================================================================
 * lane-rotator.js — weekly-quota cross-lane content rotation.
 *
 * WHY: a feed that's four articles in a row (or four quote cards in a row)
 * reads as automated. The rotator enforces VARIETY: every account has a
 * per-week quota per content lane, and each new piece is routed to the
 * highest-priority lane that still has quota left, biased toward what the
 * piece naturally wants to be ("content signal").
 *
 * This replaced a simpler anti-drift rule ("swap if the default lane ran
 * 2-of-the-last-3") which still collapsed into monotone output whenever the
 * topic signal was monotone. Quotas fix that structurally.
 *
 * LANES (public engine = written + visual content only):
 *   article      long-form piece for your blog/newsletter
 *   canva-post   designed static/carousel visual from your Canva templates
 *   text-post    platform-native text (no visual asset required)
 *   repurpose    a past winner re-angled into a new piece
 *
 * Default weekly quota per account (override in config.lanes.weekly_quota):
 *   article: 2 · canva-post: 2 · text-post: 2 · repurpose: 1   → 7/week
 *
 * ALGORITHM (pickLane):
 *   1. laneOverride is honored unconditionally (some pieces are pinned).
 *   2. Compute remaining quota per lane this ISO week (Mon–Sun buckets; both
 *      of a week's pipeline runs share the same counters).
 *   3. If no lane has quota left → return the default lane with overQuota:true
 *      (the pipeline logs it — the operator decides whether to add a slot).
 *   4. Default lane = signalToDefault(contentSignal); if it has quota → pick it.
 *   5. Else walk the fallback chain (nearest-format neighbors first).
 *   6. Safety: if the chain is exhausted, pick the lane with the most quota left.
 *
 * RECORD: recordLane increments the week bucket. The pipeline MUST call this
 * after a successful build only — a failed build must not burn quota.
 * ========================================================================== */

'use strict';
const fs = require('fs');
const path = require('path');

const { LOG_DIR, loadConfig } = require('./common');
const STATE_FILE = path.join(LOG_DIR, 'lane-rotation.json');

const LANES = ['article', 'canva-post', 'text-post', 'repurpose'];

const DEFAULT_WEEKLY_QUOTA = {
  'article':    2,
  'canva-post': 2,
  'text-post':  2,
  'repurpose':  1,
};
function weeklyQuota(cfg) {
  const q = (cfg && cfg.lanes && cfg.lanes.weekly_quota) || {};
  return Object.fromEntries(LANES.map((l) => [l, Number.isFinite(q[l]) ? q[l] : DEFAULT_WEEKLY_QUOTA[l]]));
}

// Content-signal → default lane. Signals describe what a piece naturally is,
// e.g. (urban-gardening niche) a "how-to" wants an article, a "listicle" wants
// a designed carousel, a "hot-take" wants a native text post.
const SIGNAL_TO_DEFAULT = {
  'deep-dive':  'article',
  'how-to':     'article',
  'explainer':  'article',
  'listicle':   'canva-post',
  'quote':      'canva-post',
  'stat':       'canva-post',
  'checklist':  'canva-post',
  'story':      'text-post',
  'hot-take':   'text-post',
  'question':   'text-post',
  'observation':'text-post',
  'winner':     'repurpose',
  'evergreen':  'repurpose',
};

// Nearest-format fallback chain — preserves intent on swap (don't yank a
// designed visual into a long-form article if another visual lane has quota).
const FALLBACK_CHAIN = {
  'article':    ['text-post', 'canva-post', 'repurpose'],
  'canva-post': ['text-post', 'article',    'repurpose'],
  'text-post':  ['canva-post', 'article',   'repurpose'],
  'repurpose':  ['text-post', 'canva-post', 'article'],
};

// ---- ISO week (Mon–Sun) → "YYYY-Www" e.g. "2026-W26" ----
function isoWeekKey(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum); // Thursday of this week
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}
function currentWeekKey(dateLike) {
  return isoWeekKey(dateLike ? new Date(dateLike) : new Date());
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch (_) { return {}; }
}
function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function emptyWeekBucket() {
  return Object.fromEntries(LANES.map((l) => [l, 0]));
}

// Per-account, per-week counts.
function weekCounts(state, account, weekKey) {
  const acct = state[account] || {};
  return (acct.weeks && acct.weeks[weekKey]) || emptyWeekBucket();
}

function defaultLaneFor(contentSignal) {
  if (!contentSignal) return 'article';
  return SIGNAL_TO_DEFAULT[contentSignal.toLowerCase()] || 'article';
}

// CORE
function pickLane({ contentSignal, account = 'default', laneOverride = null, dateLike = null, config = null } = {}) {
  // Hard pin: pieces with an explicit lane ALWAYS take that lane. Quota is
  // still counted so a pinned piece consumes its lane's slot.
  if (laneOverride && LANES.includes(laneOverride)) {
    return { lane: laneOverride, reason: `hard override → ${laneOverride}`, forcedSwap: false, overQuota: false, considered: [laneOverride] };
  }
  const QUOTA = weeklyQuota(config || loadConfig());
  const state = loadState();
  const wk = currentWeekKey(dateLike);
  const counts = weekCounts(state, account, wk);
  const remaining = Object.fromEntries(LANES.map((l) => [l, Math.max(0, QUOTA[l] - counts[l])]));
  const totalRemaining = Object.values(remaining).reduce((a, b) => a + b, 0);

  const def = defaultLaneFor(contentSignal);
  const considered = [def];

  // Week is full — return the default lane but flag overQuota so the pipeline
  // can decide whether to actually build (default: skip; operator can override).
  if (totalRemaining === 0) {
    return { lane: def, reason: `weekly quota met on ${account} (week ${wk}) — over-quota piece`, forcedSwap: false, overQuota: true, considered, weekCounts: counts };
  }

  // Default has room — take it.
  if (remaining[def] > 0) {
    return { lane: def, reason: `default ${def} for signal "${contentSignal}" (remaining this week: ${remaining[def]})`, forcedSwap: false, overQuota: false, considered, weekCounts: counts };
  }

  // Default is at cap — walk the fallback chain.
  for (const alt of FALLBACK_CHAIN[def]) {
    considered.push(alt);
    if (remaining[alt] > 0) {
      return { lane: alt, reason: `${def} at weekly cap (${QUOTA[def]}/${QUOTA[def]}) — swapped to ${alt} (remaining: ${remaining[alt]})`, forcedSwap: true, overQuota: false, considered, weekCounts: counts };
    }
  }

  // Chain exhausted but totalRemaining > 0 → safety: pick lane with most remaining.
  const best = LANES.slice().sort((a, b) => remaining[b] - remaining[a])[0];
  return { lane: best, reason: `chain exhausted, safety pick ${best}`, forcedSwap: true, overQuota: false, considered, weekCounts: counts };
}

function recordLane({ account = 'default', lane, postId, date } = {}) {
  if (!lane || !LANES.includes(lane)) return;
  const state = loadState();
  const wk = currentWeekKey(date);
  if (!state[account]) state[account] = { weeks: {}, history: [] };
  if (!state[account].weeks) state[account].weeks = {};
  if (!state[account].weeks[wk]) state[account].weeks[wk] = emptyWeekBucket();
  state[account].weeks[wk][lane] = (state[account].weeks[wk][lane] || 0) + 1;
  // Rolling history (last 28 entries — ~4 weeks) for debugging.
  if (!state[account].history) state[account].history = [];
  state[account].history.push({ lane, postId: postId || null, date: date || new Date().toISOString().slice(0, 10), week: wk });
  if (state[account].history.length > 28) state[account].history = state[account].history.slice(-28);
  saveState(state);
}

function summary({ account = 'default', dateLike = null, config = null } = {}) {
  const QUOTA = weeklyQuota(config || loadConfig());
  const state = loadState();
  const wk = currentWeekKey(dateLike);
  const counts = weekCounts(state, account, wk);
  const remaining = Object.fromEntries(LANES.map((l) => [l, Math.max(0, QUOTA[l] - counts[l])]));
  return {
    account, week: wk, quota: QUOTA, used: counts, remaining,
    totalUsed: Object.values(counts).reduce((a, b) => a + b, 0),
    totalWeekly: Object.values(QUOTA).reduce((a, b) => a + b, 0),
  };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const config = loadConfig();
  if (args[0] === '--summary') { console.log(JSON.stringify(summary({ account: args[1] || 'default', config }), null, 2)); process.exit(0); }
  if (args[0] === '--pick') { console.log(JSON.stringify(pickLane({ contentSignal: args[1] || 'deep-dive', account: args[2] || 'default', config }), null, 2)); process.exit(0); }
  if (args[0] === '--record') { recordLane({ account: args[3] || 'default', lane: args[1], postId: args[2] || 'manual' }); console.log(`recorded ${args[1]} for ${args[3] || 'default'} (week ${currentWeekKey()})`); process.exit(0); }
  if (args[0] === '--reset') { try { fs.unlinkSync(STATE_FILE); } catch (_) {} console.log('state cleared'); process.exit(0); }
  console.log('usage: node agents/lane-rotator.js [--summary <account>] | [--pick <signal> <account>] | [--record <LANE> <postId> <account>] | [--reset]   [--config <path>]');
  process.exit(0);
}

module.exports = { pickLane, recordLane, summary, defaultLaneFor, currentWeekKey, LANES, SIGNAL_TO_DEFAULT, FALLBACK_CHAIN };
