#!/usr/bin/env node
/* ============================================================================
 * AGENT 1 — BRAND VOICE MAINTAINER
 *
 * Your voice canon lives in two files you own (see config/README.md):
 * the voice fingerprint and the content-rules doc. This agent keeps a
 * *living* "Brand Voice" tab in your Google Sheet in sync with that canon
 * AND with reality:
 *
 *   1. Publishes a one-screen voice reference (sources, banned phrases,
 *      hook rules) into the tab so you always have it at a glance.
 *   2. Scans the week's produced content (output/approved + output/pending)
 *      for banned-phrase DRIFT and reports exactly what slipped and where.
 *   3. Learns "what's working now" from the Performance Log tab and
 *      refreshes three on-voice example lines via the Anthropic API.
 *   4. Snapshots the reference to logs/ and emails you a short weekly digest.
 *
 * Cadence: weekly (Mondays 6:45 AM local by default) via launchd.
 *
 * Run:
 *   node agents/agent1-brand-voice.js --once      run now + install launchd
 *   node agents/agent1-brand-voice.js --run       run maintenance only
 *   node agents/agent1-brand-voice.js --install   install launchd only
 *
 * Operating rule: never crash — ALWAYS write the tab + send the digest even
 * if the API or a data source is unavailable.
 * ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

// ---------------------------------------------------------------------------
// Paths + CLI args + config
// ---------------------------------------------------------------------------
const HOME = process.env.HOME || os.homedir();
const ROOT = path.resolve(__dirname, '..');

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? (process.argv[i + 1] || '') : '';
}
const CONFIG_PATH = path.resolve(ROOT, argValue('--config') || path.join('config', 'config.json'));
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch (_) {
    console.error(`Missing or invalid config at ${CONFIG_PATH} — copy config/config.example.json to config/config.json (see ONBOARDING.md).`);
    process.exit(1);
  }
}
const CFG = loadConfig();

const APPROVED = path.join(ROOT, 'output', 'approved');
const PENDING = path.join(ROOT, 'output', 'pending');
const LOG_DIR = path.join(ROOT, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'brandvoice-log.txt');
const PLIST = path.join(HOME, 'Library', 'LaunchAgents', 'com.contentmachine.brandvoice.plist');
fs.mkdirSync(LOG_DIR, { recursive: true });

const SHEET_ID = (CFG.data && CFG.data.google_sheet_id) || '';
const FINGERPRINT_FILE = (CFG.voice && CFG.voice.fingerprint_file) || 'config/voice-fingerprint.md';
const CONTENT_RULES_FILE = (CFG.voice && CFG.voice.content_rules_file) || 'config/content-rules.md';

const ts = () => new Date().toISOString();
function log(m) { const l = `[${ts()}] ${m}`; console.log(l); try { fs.appendFileSync(LOG_FILE, l + '\n'); } catch (_) {} }
function logErr(s, e) { log(`ERROR [${s}]: ${e && e.message ? e.message : e}`); }
const ymd = () => new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Env — one repo-root .env (see .env.example). Keys used here:
// ANTHROPIC_API_KEY, ANTHROPIC_MODEL (optional), MAIL_SENDER.
// ---------------------------------------------------------------------------
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
const ENV = loadEnv();
const val = (...k) => { for (const x of k) { const v = (ENV[x] || process.env[x] || '').trim(); if (v && !/^\[.*\]$/.test(v)) return v; } return ''; };
const ANTHROPIC_KEY = val('ANTHROPIC_API_KEY');
const MODEL = val('ANTHROPIC_MODEL') || 'claude-sonnet-5';
const MAIL_SENDER = val('MAIL_SENDER');
const DIGEST_EMAIL = (CFG.approval && CFG.approval.approval_channel_email) || MAIL_SENDER;

async function getGoogle(scopes) {
  const { google } = require('googleapis');
  const auth = new google.auth.GoogleAuth({ scopes });
  return { google, client: await auth.getClient() };
}

// ---------------------------------------------------------------------------
// Banned phrases — same default generic-AI-filler list the writer uses, plus
// whatever you add in config.voice.banned_phrases. The canon files remain the
// source of truth for voice; this list only powers the mechanical drift scan.
// ---------------------------------------------------------------------------
const DEFAULT_BANNED = [
  'game-changer', 'game changer', 'revolutionize', 'delve',
  "in today's fast-paced world", 'unlock the secret', 'elevate your',
];
const BANNED = [...new Set([...DEFAULT_BANNED, ...((CFG.voice && CFG.voice.banned_phrases) || [])])];

// Generic hook discipline (structure rules, not niche content).
const HOOK_RULES = 'Write the hook FIRST — it is 50% of the score. Score it honestly 1-10; below 8, rewrite. Never open two consecutive pieces with the same structure. The final line of social copy should invite a reply your audience can type in a few words.';

// ---------------------------------------------------------------------------
// DRIFT SCAN — produced content over the last 7 days.
// ---------------------------------------------------------------------------
// Skip meta / scaffolding files — review notes and edit logs are not
// shippable copy, so banned words inside them aren't drift.
const META_FILE = /EDIT_FLAGS|_dismissed|^README|^NOTES|\.flag\./i;
function recentMd(dir, days = 7) {
  const cutoff = Date.now() - days * 86400000;
  try {
    return fs.readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith('.md') && !META_FILE.test(f))
      .map((f) => path.join(dir, f))
      .filter((p) => { try { return fs.statSync(p).isFile() && fs.statSync(p).mtime.getTime() > cutoff; } catch (_) { return false; } });
  } catch (_) { return []; }
}
// Only look at the parts of a package that BECOME copy — captions / hooks /
// article body — not our own rule annotations, table scaffolding, or labels,
// so we don't flag a banned word inside a "banned words" instruction line.
function copyOnly(text) {
  return text.split(/\r?\n/)
    .filter((ln) => !/^\s*(\*\*|#{1,6}\s|>|\||\[|-{3,}|hashtags?:|version\b|score|hook formula|banned|do not|never )/i.test(ln))
    .join('\n');
}
function scanDrift() {
  const files = [...recentMd(APPROVED), ...recentMd(PENDING)];
  const hits = [];
  for (const f of files) {
    let raw; try { raw = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
    const body = copyOnly(raw);
    for (const phrase of BANNED) {
      const re = new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      if (re.test(body)) hits.push({ file: path.basename(f), phrase });
    }
  }
  log(`Drift scan: ${files.length} package(s) in last 7d, ${hits.length} flag(s)`);
  return { scanned: files.length, hits };
}

// ---------------------------------------------------------------------------
// "WHAT'S WORKING" — Performance Log tab + refreshed examples via the API.
// ---------------------------------------------------------------------------
async function readSheet(tab, range) {
  if (!SHEET_ID) { log(`sheet:${tab}: no data.google_sheet_id configured — skipping`); return []; }
  try {
    const { google, client } = await getGoogle(['https://www.googleapis.com/auth/spreadsheets']);
    const sheets = google.sheets({ version: 'v4', auth: client });
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${tab}!${range}` });
    return r.data.values || [];
  } catch (e) { logErr(`sheet:${tab}`, e); return []; }
}
function rowsToObjs(rows) { const h = rows[0] || []; return rows.slice(1).map((r) => { const o = {}; h.forEach((k, i) => o[k] = r[i] || ''); return o; }); }

async function claudeRefresh(voiceCanon, perfRows, drift) {
  if (!ANTHROPIC_KEY) return null;
  const perf = (perfRows || []).slice(-5)
    .map((r) => `- ${(r['What Worked'] || r['Notes'] || r['Top Performer'] || '').toString().slice(0, 160)}`)
    .filter((s) => s.length > 4).join('\n') || '(no performance rows yet)';
  const driftTxt = drift.hits.length ? drift.hits.map((h) => `${h.phrase} → ${h.file}`).join('; ') : 'none — copy is clean';
  const brand = CFG.brand || {};
  const sys = `You maintain the living Brand Voice reference for ${brand.name || 'this brand'}'s content engine. ${brand.one_line || ''}\nCanon (do not contradict):\n${(voiceCanon || '').slice(0, 60000)}\n\nReturn via the emit tool ONLY. Each example must be a single on-voice line (a hook or opener) that obeys the canon and could ship today. Never use any banned phrase: ${BANNED.join(' · ')}.`;
  const user = `THIS WEEK'S SIGNAL.\nPerformance Log (recent):\n${perf}\n\nDrift flags in produced copy: ${driftTxt}\n\nProduce: workingNow (2 sentences on the register/hook style earning attention this week), evolutionNote (1 sentence — one concrete adjustment to bias toward next week), driftAdvice (1 sentence — if drift flags exist, how to course-correct; else affirm what's holding), examples (3 fresh on-voice opener lines).`;
  const body = {
    model: MODEL, max_tokens: 1200, system: [{ type: 'text', text: sys, cache_control: { type: 'ephemeral' } }],
    tools: [{ name: 'emit', description: 'Emit the refreshed living-voice fields.', input_schema: { type: 'object', properties: {
      workingNow: { type: 'string' }, evolutionNote: { type: 'string' }, driftAdvice: { type: 'string' },
      examples: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 3 },
    }, required: ['workingNow', 'examples'] } }],
    tool_choice: { type: 'tool', name: 'emit' },
    messages: [{ role: 'user', content: user }],
  };
  // This is a short response (~1 min budget), so plain fetch is fine here.
  // For LONG generations use the streaming curl transport in agent3-writer.js
  // — some networks kill any HTTP response idle for ~60s.
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'prompt-caching-2024-07-31', 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`Anthropic HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
    const j = await res.json();
    const tu = (j.content || []).find((c) => c.type === 'tool_use');
    if (!tu) throw new Error('no tool_use');
    log('Claude: living-voice fields refreshed');
    return tu.input;
  } catch (e) { logErr('anthropic', e); return null; }
}

// ---------------------------------------------------------------------------
// WRITE the Brand Voice tab (full rewrite — Agent 1 owns this tab).
// ---------------------------------------------------------------------------
function buildRows(refresh, drift, canonHeadings) {
  const d = ymd();
  const driftCell = drift.hits.length
    ? `${drift.hits.length} flag(s) in ${drift.scanned} package(s): ` + drift.hits.map((h) => `"${h.phrase}" (${h.file})`).join(' · ')
    : `Clean — ${drift.scanned} package(s) scanned, no banned phrases.`;
  return [
    ['Section', 'Guidance', 'Updated'],
    ['Voice sources', `Fingerprint: ${FINGERPRINT_FILE} · Content rules: ${CONTENT_RULES_FILE}. Edit those files — this tab is a generated snapshot, not the source of truth.`, d],
    ['Canon sections found', canonHeadings.length ? canonHeadings.join(' · ') : '(none matched — check the headings in your content-rules doc against agents/brand-context.js)', d],
    ['Banned phrases', BANNED.join(' · '), d],
    ['Hook discipline', HOOK_RULES, d],
    ['Working now (last 7d)', refresh && refresh.workingNow ? refresh.workingNow : '(API unavailable — see Performance Log)', d],
    ['Evolution note', refresh && refresh.evolutionNote ? refresh.evolutionNote : '(none this week)', d],
    ['Drift watch', driftCell + (refresh && refresh.driftAdvice ? ` — ${refresh.driftAdvice}` : ''), d],
    ['On-voice examples (refreshed)', refresh && refresh.examples ? refresh.examples.map((e, i) => `${i + 1}. ${e}`).join('\n') : '(API unavailable)', d],
    ['Maintained by', `Agent 1 (agents/agent1-brand-voice.js), weekly. Canon lives in ${CONTENT_RULES_FILE} — edit there first.`, d],
  ];
}
async function writeBrandVoiceTab(rows) {
  if (!SHEET_ID) { log('Brand Voice tab: no data.google_sheet_id configured — snapshot only'); return false; }
  try {
    const { google, client } = await getGoogle(['https://www.googleapis.com/auth/spreadsheets']);
    const sheets = google.sheets({ version: 'v4', auth: client });
    await sheets.spreadsheets.values.clear({ spreadsheetId: SHEET_ID, range: 'Brand Voice!A1:Z100' });
    await sheets.spreadsheets.values.update({ spreadsheetId: SHEET_ID, range: 'Brand Voice!A1', valueInputOption: 'RAW', requestBody: { values: rows } });
    log(`Brand Voice tab: rewritten (${rows.length - 1} sections)`);
    return true;
  } catch (e) { logErr('sheet-write', e); return false; }
}

function snapshot(rows) {
  try {
    const md = `# Brand Voice — living reference (Agent 1)\n_Snapshot ${ymd()} · canon: ${CONTENT_RULES_FILE}_\n\n` +
      rows.slice(1).map((r) => `## ${r[0]}\n${r[1]}\n`).join('\n');
    const f = path.join(LOG_DIR, `brand-voice-${ymd()}.md`);
    fs.writeFileSync(f, md);
    log(`Snapshot: ${path.basename(f)}`);
  } catch (e) { logErr('snapshot', e); }
}

async function sendDigest(subject, body) {
  if (!DIGEST_EMAIL) { log('Email: no approval_channel_email / MAIL_SENDER — digest not sent'); return; }
  try { const { sendMail } = require('./mailer'); const id = await sendMail(DIGEST_EMAIL, subject, body); log(`Email: brand-voice digest sent (${id})`); }
  catch (e) { logErr('mail', e); const f = path.join(LOG_DIR, `brandvoice-digest-${ymd()}.txt`); fs.writeFileSync(f, `Subject: ${subject}\n\n${body}`); log(`Email FAILED — saved ${path.basename(f)}`); }
}

// ---------------------------------------------------------------------------
async function maintain() {
  log('================ BRAND VOICE MAINTAINER RUN START ================');
  // LESSON baked into this design: an earlier version of this engine sliced
  // the first N chars of one giant ops doc as the "canon" — which was the
  // housekeeping preamble, NOT the voice rules, so weekly "on-voice examples"
  // were generated without the voice rules and drifted for weeks. The canon
  // is now two dedicated files, and brand-context.js extracts sections BY
  // HEADING, never by character slice.
  const bc = require('./brand-context');
  const readRel = (rel) => { try { return fs.readFileSync(path.resolve(ROOT, rel), 'utf8'); } catch (_) { return ''; } };
  const voice = readRel(FINGERPRINT_FILE);
  const contentDoc = readRel(CONTENT_RULES_FILE);
  const canon = bc.buildBrandContext({ voice, hooks: '', contentDoc });
  const canonHeadings = (bc.extractContentSections(contentDoc) || '')
    .split(/\r?\n/).filter((l) => /^##\s/.test(l)).map((l) => l.replace(/^##\s*/, '').trim());

  const drift = scanDrift();
  const perf = rowsToObjs(await readSheet('Performance Log', 'A1:Z200'));
  const refresh = await claudeRefresh(canon, perf, drift);

  const rows = buildRows(refresh, drift, canonHeadings);
  await writeBrandVoiceTab(rows);
  snapshot(rows);

  const subject = `Brand Voice — ${ymd()}`;
  let body = `Brand Voice reference refreshed (${rows.length - 1} sections).\n\n`;
  body += `WORKING NOW:\n${refresh && refresh.workingNow ? refresh.workingNow : '(API unavailable)'}\n\n`;
  if (refresh && refresh.evolutionNote) body += `BIAS NEXT WEEK:\n${refresh.evolutionNote}\n\n`;
  body += `DRIFT WATCH:\n`;
  if (drift.hits.length) {
    body += `${drift.hits.length} flag(s) across ${drift.scanned} package(s):\n` + drift.hits.map((h) => `  • "${h.phrase}" → ${h.file}`).join('\n') + '\n';
    if (refresh && refresh.driftAdvice) body += `Fix: ${refresh.driftAdvice}\n`;
  } else {
    body += `Clean — ${drift.scanned} package(s) scanned, no banned phrases.\n`;
  }
  if (refresh && refresh.examples) body += `\nFRESH ON-VOICE LINES:\n` + refresh.examples.map((e, i) => `${i + 1}. ${e}`).join('\n') + '\n';
  body += `\nFull living doc: the Brand Voice tab in your sheet. Canon: ${CONTENT_RULES_FILE}.\n`;
  await sendDigest(subject, body);

  log('================ BRAND VOICE MAINTAINER RUN END ================\n');
  return { subject, body, drift, refresh, rows };
}

// ---- launchd install (weekly, Monday 6:45 AM local by default) ----
function installLaunchd() {
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.contentmachine.brandvoice</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${path.join(ROOT, 'agents', 'agent1-brand-voice.js')}</string>
    <string>--run</string>
    <string>--config</string>
    <string>${CONFIG_PATH}</string>
  </array>
  <key>WorkingDirectory</key><string>${ROOT}</string>
  <!-- Weekly, Monday 6:45 AM local. Weekday 1 = Monday. -->
  <key>StartCalendarInterval</key>
  <dict><key>Weekday</key><integer>1</integer><key>Hour</key><integer>6</integer><key>Minute</key><integer>45</integer></dict>
  <key>EnvironmentVariables</key>
  <dict><key>HOME</key><string>${HOME}</string><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>StandardOutPath</key><string>${path.join(LOG_DIR, 'launchd-brandvoice.out')}</string>
  <key>StandardErrorPath</key><string>${path.join(LOG_DIR, 'launchd-brandvoice.err')}</string>
  <key>RunAtLoad</key><false/>
</dict>
</plist>
`;
  try {
    fs.mkdirSync(path.dirname(PLIST), { recursive: true });
    fs.writeFileSync(PLIST, plist);
    const uid = process.getuid();
    try { execSync(`launchctl bootout gui/${uid}/com.contentmachine.brandvoice`, { stdio: 'ignore' }); } catch (_) {}
    try { execSync(`launchctl bootstrap gui/${uid} "${PLIST}"`, { stdio: 'pipe' }); }
    catch (_) { execSync(`launchctl load -w "${PLIST}"`, { stdio: 'pipe' }); }
    log(`launchd: installed ${path.basename(PLIST)} (Mondays 6:45 AM local)`);
    return true;
  } catch (e) { logErr('launchd', e); return false; }
}

async function main() {
  // --install : wire the weekly launchd trigger WITHOUT a live maintenance
  //             run (useful when Google auth is mid-setup — the first real
  //             pass fires next Monday).
  if (process.argv.includes('--install')) { installLaunchd(); return; }
  const once = process.argv.includes('--once');
  await maintain();
  if (once) installLaunchd();
}
if (require.main === module) main().then(() => process.exit(0)).catch((e) => { logErr('main', e); process.exit(0); });
module.exports = { maintain, scanDrift, BANNED };
