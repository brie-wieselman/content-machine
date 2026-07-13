#!/usr/bin/env node
/* ============================================================================
 * QUALITY MONITOR — the grading gate + silent-degradation watchdog
 *
 * Two jobs in one module:
 *
 * A) CLI GRADING GATE (what pipeline.js invokes):
 *      node agents/quality-monitor.js --config config/config.json
 *    Grades every ungraded package in output/pending/ against your voice
 *    fingerprint + content rules using the Anthropic API. Rubric: hook
 *    strength carries 50% of the weight; the rest is curiosity, clarity,
 *    voice match, and platform fit. Verdicts:
 *      >= 9   ship      grade block appended, stays in pending for approval
 *      7-8.9  fix       grade + top fixes appended — you decide
 *      < 7    reject    moved to output/rejected/ with the reasons attached
 *
 * B) STREAK TRACKER (exported checkAndRecord, used by the pipeline runner):
 *    persistent cross-run detection of two failure modes that a simple
 *    "did the step exit 0?" alert can never catch:
 *      1. The grader silently not running (SKIPPED/FAIL) run after run —
 *         "skipped" is not a failure status, so nothing else alerts, and
 *         meanwhile no one is checking quality at all.
 *      2. The writer silently falling back to its templated generator —
 *         the fallback IS the designed graceful-degradation path, so the
 *         writer step still reports OK even when every package that day is
 *         identical canned scaffolding regardless of topic.
 *    Both patterns once sat unnoticed in logs for weeks. Streaks persist in
 *    logs/quality-streak-state.json and alert once a threshold is crossed —
 *    small enough not to fire on one transient blip, fast enough not to take
 *    weeks to notice.
 * ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Part B — streak tracker (pure module, no config needed)
// ---------------------------------------------------------------------------
const STATE_FILE_NAME = 'quality-streak-state.json';

function loadState(logDir) {
  const p = path.join(logDir, STATE_FILE_NAME);
  try { return { graderSkipStreak: 0, fallbackRunStreak: 0, ...JSON.parse(fs.readFileSync(p, 'utf8')) }; }
  catch (_) { return { graderSkipStreak: 0, fallbackRunStreak: 0 }; }
}
function saveState(logDir, state) {
  try { fs.writeFileSync(path.join(logDir, STATE_FILE_NAME), JSON.stringify(state, null, 2)); } catch (_) {}
}

/**
 * @param {string[]} pkgFiles - this run's package .md files (post grader-gate,
 *   so rejected packages are already excluded — this checks what could ship).
 * @param {string|undefined} graderStatus - the grader step's status this run
 *   ('OK' | 'SKIPPED' | 'FAIL' | 'DRY' | undefined-if-not-run).
 * @param {string} logDir - repo logs/ dir (where the streak state persists).
 * @returns {string[]} human-readable alert messages, empty if nothing crossed
 *   a threshold.
 */
function checkAndRecord({ pkgFiles, graderStatus, logDir }) {
  const state = loadState(logDir);
  const alerts = [];

  // --- grader dead-again detector ---
  // 'SKIPPED' or 'FAIL' both mean no grades were produced this run (an
  // unreachable API demotes to SKIPPED; a thrown error is FAIL) — a
  // persistent FAIL is exactly as silent-drift-prone as SKIPPED, so both
  // count toward the same streak. 'OK' means real grades were written.
  // Anything else (DRY, undefined — disabled / no packages) leaves the
  // streak alone, since there was nothing to grade this run.
  if (graderStatus === 'SKIPPED' || graderStatus === 'FAIL') {
    state.graderSkipStreak += 1;
    if (state.graderSkipStreak >= 2) {
      alerts.push(
        `Grader has been ${graderStatus} ${state.graderSkipStreak} runs in a row — no quality grades are being produced, ` +
        `so nothing is checking hook strength / voice fit / clarity before packages reach you. Check ` +
        `logs/pipeline-log.txt and logs/grader-log.txt for the cause.`
      );
    }
  } else if (graderStatus === 'OK') {
    state.graderSkipStreak = 0;
  }

  // --- canned-template flood detector ---
  const fallbackCount = (pkgFiles || []).filter((f) => {
    try { return /\*\*Generation mode:\*\*\s*FALLBACK/.test(fs.readFileSync(f, 'utf8')); } catch (_) { return false; }
  }).length;
  const total = (pkgFiles || []).length;

  if (total === 0) {
    // Nothing to check this run (disabled agents, dry sweep, etc.) — leave
    // the streak alone rather than resetting it, same philosophy as the
    // grader streak above. A zero-package run says nothing about whether the
    // previous run's fallback problem has actually been resolved.
  } else if (fallbackCount === total) {
    // 100% fallback this run is loud enough to alert immediately, streak or not.
    alerts.push(
      `ALL ${total} package(s) generated this run used the FALLBACK templated generator, not the real API — ` +
      `every piece is canned scaffolding regardless of topic. Check logs/writer-log.txt for the transport error.`
    );
    state.fallbackRunStreak += 1;
  } else if (fallbackCount > 0) {
    state.fallbackRunStreak += 1;
    if (state.fallbackRunStreak >= 2) {
      alerts.push(
        `${fallbackCount}/${total} package(s) fell back to the templated generator this run, and at least one ` +
        `package has fallen back on ${state.fallbackRunStreak} consecutive runs.`
      );
    }
  } else {
    state.fallbackRunStreak = 0;
  }

  saveState(logDir, state);
  return alerts;
}

// ---------------------------------------------------------------------------
// Part A — CLI grading gate
// ---------------------------------------------------------------------------
const ROOT = path.resolve(__dirname, '..');
function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? (process.argv[i + 1] || '') : '';
}

function loadConfig(configPath) {
  try { return JSON.parse(fs.readFileSync(configPath, 'utf8')); }
  catch (_) {
    console.error(`Missing or invalid config at ${configPath} — copy config/config.example.json to config/config.json (see ONBOARDING.md).`);
    process.exit(1);
  }
}

function loadEnv() {
  const env = {};
  try {
    fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/).forEach((ln) => {
      const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) env[m[1]] = m[2].trim();
    });
  } catch (_) {}
  return env;
}

const GRADE_MARKER = /^## GRADE — /m; // presence = already graded, skip

function gradeSchema() {
  return {
    type: 'object',
    properties: {
      score: { type: 'number', description: 'Overall 1-10. Hook strength is 50% of the weight; curiosity, clarity, voice match, and platform fit split the rest. Be strict — a 9 should be rare.' },
      hook_strength: { type: 'number', description: '1-10: does the first line stop the scroll in 3 seconds?' },
      voice_match: { type: 'number', description: '1-10: does it obey the voice fingerprint and avoid the banned phrases?' },
      clarity: { type: 'number', description: '1-10: self-contained, plain language, no internal shorthand?' },
      top_fixes: { type: 'array', items: { type: 'string' }, maxItems: 3, description: 'Top fixes ranked by impact. Empty if score >= 9.' },
      verdict: { type: 'string', enum: ['ship', 'fix', 'reject'], description: 'ship = 9+, fix = 7-8.9, reject = below 7.' },
    },
    required: ['score', 'hook_strength', 'voice_match', 'clarity', 'verdict'],
  };
}

// Short response, so plain fetch with a couple of retries is fine here. For
// LONG generations use the streaming curl transport in agent3-writer.js —
// some networks kill any HTTP response that stays idle for ~60s.
async function gradeWithApi({ apiKey, model, voiceCtx, banned, draft, log }) {
  const sys = `You are a strict quality gate for a content engine. Grade the DRAFT package against these voice + content rules:\n${voiceCtx.slice(0, 40000)}\n\nBanned phrases (automatic voice_match penalty if present): ${banned.join(' · ')}.\n\nCall the emit_grade tool. Grade the copy that would actually be posted — ignore the package's own metadata lines (Date / Source / Generation mode / scores).`;
  const body = {
    model, max_tokens: 1000,
    system: [{ type: 'text', text: sys, cache_control: { type: 'ephemeral' } }],
    tools: [{ name: 'emit_grade', description: 'Emit the grade for this draft.', input_schema: gradeSchema() }],
    tool_choice: { type: 'tool', name: 'emit_grade' },
    messages: [{ role: 'user', content: `DRAFT PACKAGE:\n\n${draft.slice(0, 30000)}` }],
  };
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'prompt-caching-2024-07-31', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`Anthropic HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
      const j = await res.json();
      const tu = (j.content || []).find((c) => c.type === 'tool_use');
      if (!tu || !tu.input || typeof tu.input.score !== 'number') throw new Error('no usable tool_use in grade response');
      return tu.input;
    } catch (e) {
      lastErr = e;
      log(`grade attempt ${attempt}/3 failed: ${e.message}`);
      if (attempt < 3) await new Promise((r) => setTimeout(r, 5000 * attempt));
    }
  }
  throw lastErr;
}

function renderGradeBlock(g) {
  let md = `\n## GRADE — ${g.score}/10 (${g.verdict.toUpperCase()})\n`;
  md += `- Hook strength: ${g.hook_strength}/10 (50% of weight)\n`;
  md += `- Voice match: ${g.voice_match}/10\n`;
  md += `- Clarity: ${g.clarity}/10\n`;
  if (Array.isArray(g.top_fixes) && g.top_fixes.length) {
    md += `\n**Top fixes (by impact):**\n` + g.top_fixes.map((f, i) => `${i + 1}. ${f}`).join('\n') + '\n';
  }
  return md;
}

async function runGate() {
  const CONFIG_PATH = path.resolve(ROOT, argValue('--config') || path.join('config', 'config.json'));
  const cfg = loadConfig(CONFIG_PATH);
  const ENV = loadEnv();
  const envVal = (k) => (ENV[k] || process.env[k] || '').trim();
  const apiKey = envVal('ANTHROPIC_API_KEY');
  const model = envVal('ANTHROPIC_MODEL') || 'claude-sonnet-5';

  const PENDING = path.join(ROOT, 'output', 'pending');
  const REJECTED = path.join(ROOT, 'output', 'rejected');
  const LOG_DIR = path.join(ROOT, 'logs');
  [PENDING, REJECTED, LOG_DIR].forEach((d) => fs.mkdirSync(d, { recursive: true }));
  const LOG_FILE = path.join(LOG_DIR, 'grader-log.txt');
  const log = (m) => { const l = `[${new Date().toISOString()}] ${m}`; console.log(l); try { fs.appendFileSync(LOG_FILE, l + '\n'); } catch (_) {} };

  log('================ QUALITY GATE RUN START ================');

  // Voice context — same two config files the writer uses.
  const bc = require('./brand-context');
  const readRel = (rel) => { try { return fs.readFileSync(path.resolve(ROOT, rel), 'utf8'); } catch (_) { return ''; } };
  const voice = readRel((cfg.voice && cfg.voice.fingerprint_file) || 'config/voice-fingerprint.md');
  const contentDoc = readRel((cfg.voice && cfg.voice.content_rules_file) || 'config/content-rules.md');
  const voiceCtx = bc.buildBrandContext({ voice, hooks: '', contentDoc });
  const DEFAULT_BANNED = [
    'game-changer', 'game changer', 'revolutionize', 'delve',
    "in today's fast-paced world", 'unlock the secret', 'elevate your',
  ];
  const banned = [...new Set([...DEFAULT_BANNED, ...((cfg.voice && cfg.voice.banned_phrases) || [])])];

  // Ungraded packages in pending.
  const files = fs.readdirSync(PENDING)
    .filter((f) => f.endsWith('.md'))
    .map((f) => path.join(PENDING, f))
    .filter((p) => { try { return !GRADE_MARKER.test(fs.readFileSync(p, 'utf8')); } catch (_) { return false; } });

  let graderStatus = 'OK';
  const survivors = [];

  if (!files.length) {
    log('No ungraded packages in output/pending/ — nothing to do.');
    graderStatus = undefined; // nothing to grade: leave streaks alone
  } else if (!apiKey) {
    // No key = no grades. Report SKIPPED so the streak tracker notices if
    // this persists — a quality gate that silently never runs is the exact
    // failure mode this module exists to catch.
    log(`SKIPPED: no ANTHROPIC_API_KEY — ${files.length} package(s) left ungraded.`);
    graderStatus = 'SKIPPED';
    survivors.push(...files);
  } else {
    for (const f of files) {
      const draft = fs.readFileSync(f, 'utf8');
      try {
        const g = await gradeWithApi({ apiKey, model, voiceCtx, banned, draft, log });
        g.score = Math.max(1, Math.min(10, Number(g.score)));
        // Recompute the verdict from the score so a mismatched enum can't
        // ship a low-scoring draft.
        g.verdict = g.score >= 9 ? 'ship' : g.score >= 7 ? 'fix' : 'reject';
        const graded = draft.trimEnd() + '\n' + renderGradeBlock(g);
        if (g.verdict === 'reject') {
          const dest = path.join(REJECTED, path.basename(f));
          fs.writeFileSync(dest, graded);
          fs.unlinkSync(f);
          log(`REJECT ${path.basename(f)} — ${g.score}/10, moved to output/rejected/`);
        } else {
          fs.writeFileSync(f, graded);
          log(`${g.verdict.toUpperCase()} ${path.basename(f)} — ${g.score}/10${g.verdict === 'fix' ? ' (fix notes appended)' : ''}`);
          survivors.push(f);
        }
      } catch (e) {
        log(`ERROR grading ${path.basename(f)}: ${e.message} — left ungraded in pending.`);
        graderStatus = 'FAIL';
        survivors.push(f);
      }
    }
  }

  // Feed part B with this run's outcome and surface any streak alerts.
  const alerts = checkAndRecord({ pkgFiles: survivors, graderStatus, logDir: LOG_DIR });
  if (alerts.length) {
    const alertFile = path.join(LOG_DIR, 'quality-alerts.txt');
    const block = `[${new Date().toISOString()}]\n` + alerts.map((a) => `- ${a}`).join('\n') + '\n\n';
    try { fs.appendFileSync(alertFile, block); } catch (_) {}
    alerts.forEach((a) => log(`ALERT: ${a}`));
  }

  log('================ QUALITY GATE RUN END ==================\n');
}

if (require.main === module) {
  runGate().then(() => process.exit(0)).catch((e) => { console.error(`ERROR [gate]: ${e.message}`); process.exit(0); });
}
module.exports = { checkAndRecord, loadState, saveState };
