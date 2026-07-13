#!/usr/bin/env node
/* ============================================================================
 * agent6b-daily-reporter.js — the ONE consolidated daily digest.
 *
 * Compiles ALL of today's pipeline output into a single morning email and
 * regenerates the local dashboard (dashboard/dashboard.html). Individual
 * agents stay quiet in pipeline mode (CM_SUPPRESS_EMAIL=1); this is the only
 * mail you get per run — one email, everything in it, written for a human.
 *
 * What it reports:
 *   - content packages awaiting your yes/no   (output/pending/*.md)
 *   - Canva visuals produced today            (output/pending/canva/)
 *   - article files written today             (output/articles/)
 *   - what you approved / rejected today      (output/approved, output/rejected)
 *   - trend + calendar data from your Google Sheet
 *   - queue depth, pipeline OK/FAIL lines, per-agent health
 *
 * Run:
 *   node agents/agent6b-daily-reporter.js [--config <path>]      compile + email + dashboard
 *   node agents/agent6b-daily-reporter.js --no-email             compile + dashboard only
 *
 * INVARIANT: ALWAYS runs, NEVER crashes. Every section is wrapped; missing
 * data just renders as "none today". A digest that says "nothing happened"
 * beats a digest that never arrives.
 * ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const { ROOT, LOG_DIR, OUT, ensureOutputDirs, loadConfig, todayLocal, makeLogger } = require('./common');
const log = makeLogger('reporter');
const logErr = log.err;
async function safe(s, fn, fb) { try { return await fn(); } catch (e) { logErr(s, e); return fb; } }

const DASH_DIR = path.join(ROOT, 'dashboard');
try { fs.mkdirSync(DASH_DIR, { recursive: true }); } catch (_) {}
ensureOutputDirs();

const CFG = loadConfig();
const SHEET_ID = (CFG.data && CFG.data.google_sheet_id) || '';
const TODAY = todayLocal();

// ---- generic fs helpers ----
function listToday(dir, filter) {
  try {
    return fs.readdirSync(dir).filter((f) => !f.startsWith('.')).map((f) => {
      const full = path.join(dir, f);
      let st; try { st = fs.statSync(full); } catch (_) { return null; }
      if (!st.isFile()) return null;
      const mday = `${st.mtime.getFullYear()}-${String(st.mtime.getMonth() + 1).padStart(2, '0')}-${String(st.mtime.getDate()).padStart(2, '0')}`;
      if (mday !== TODAY) return null;
      if (filter && !filter(f)) return null;
      return { name: f, path: full };
    }).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
  } catch (_) { return []; }
}
function countToday(dir) { return listToday(dir).length; }

// ---- 1. content packages awaiting review ----
function parsePackage(file) {
  const md = fs.readFileSync(file.path, 'utf8');
  const item = { file: file.name, path: file.path };
  const t = md.match(/^# Content Package — (.+)$/m); item.topic = t ? t[1].trim() : file.name.replace(/\.md$/, '');
  const acc = md.match(/\*\*Platforms?:\*\*\s*(.+)/i); item.platforms = acc ? acc[1].trim() : '';
  const hk = md.match(/\*\*Hook(?:\s*\((\d+)\/10\))?:\*\*\s*(.+)/);
  if (hk) { item.hook = hk[2].trim(); item.hookScore = hk[1] || null; }
  const fm = md.match(/\*\*Format:\*\*\s*(article|canva-post|text-post|repurpose)/i) || md.match(/\[(ARTICLE|CANVA-POST|TEXT-POST|REPURPOSE)\]/);
  item.format = fm ? fm[1].toLowerCase() : 'text-post';
  const cap = md.match(/### Caption\n([\s\S]*?)(?:\n\n|\n###)/i);
  item.caption = cap ? cap[1].split('\n').filter((l) => l.trim()).slice(0, 2).join(' / ') : '';
  // post-grader output: sibling <file>.grade.txt written by the grading stage.
  // Surface the score + verdict so the grade shows in the morning digest.
  try {
    const gp = file.path.replace(/\.md$/, '.grade.txt');
    if (fs.existsSync(gp)) {
      const g = fs.readFileSync(gp, 'utf8');
      const gs = g.match(/Score:\s*(\d+(?:\.\d+)?)\s*\/\s*10/i);
      const gv = g.match(/(?:^|\n)\s*(?:Verdict:\s*)?(ship|rewrite hook|kill)\b/i);
      if (gs) item.grade = gs[1];
      if (gv) item.gradeVerdict = gv[1].toLowerCase();
    }
  } catch (_) {}
  return item;
}
function gatherContent() {
  const files = listToday(OUT.pending, (f) => f.endsWith('.md'));
  const items = [];
  for (const f of files) { try { items.push(parsePackage(f)); } catch (e) { logErr(`parse:${f.name}`, e); } }
  return items;
}

// ---- 2. canva visuals ----
function gatherCanva() {
  const dir = path.join(OUT.pending, 'canva');
  // images only — never .md handoffs or .json specs (publishing a .md as
  // media once made the scheduler API 500)
  return listToday(dir, (f) => /\.(png|jpe?g|webp)$/i.test(f));
}

// ---- 3. article files written today ----
function gatherArticles() {
  const files = listToday(OUT.articles, (f) => /\.(md|html)$/i.test(f));
  // de-dupe md/html pairs by basename
  const seen = new Set(); const out = [];
  for (const f of files) {
    const base = f.name.replace(/\.(md|html)$/i, '');
    if (seen.has(base)) continue;
    seen.add(base);
    let firstLine = '';
    try {
      const md = fs.readFileSync(f.path, 'utf8');
      firstLine = (md.match(/^#\s*(.+)$/m) || [])[1] || md.split('\n').find((l) => l.trim()) || '';
    } catch (_) {}
    out.push({ name: f.name, path: f.path, title: firstLine.slice(0, 140) });
  }
  return out;
}

// ---- 4. Google Sheets ----
async function sheetsClient() {
  const { google } = require('googleapis');
  const auth = new google.auth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
  return google.sheets({ version: 'v4', auth: await auth.getClient() });
}
async function readTab(sheets, tab) {
  const r = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `'${tab}'!A1:Z500` });
  const rows = r.data.values || [];
  if (rows.length < 2) return [];
  const head = rows[0].map((h) => (h || '').toLowerCase().trim());
  return rows.slice(1).map((row) => { const o = {}; head.forEach((h, i) => { o[h] = (row[i] || '').trim(); }); return o; });
}
const col = (row, ...names) => { for (const n of names) { for (const k of Object.keys(row)) if (k.includes(n)) return row[k]; } return ''; };
function toYmd(s) {
  s = (s || '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s); // handles "Jun 09, 2026"
  if (isNaN(d)) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const isToday = (s) => toYmd(s) === TODAY;

async function gatherSheets() {
  const out = { outliers: [], calToday: [], calWeek: 0, valueAsk: null, empty: [] };
  if (!SHEET_ID) { out.empty.push('sheets (no config.data.google_sheet_id)'); return out; }
  let sheets;
  try { sheets = await sheetsClient(); } catch (e) { logErr('sheets-auth', e); out.empty.push('sheets (auth failed)'); return out; }

  await safe('daily-outlier', async () => {
    const rows = (await readTab(sheets, 'Daily Outlier')).filter((r) => isToday(col(r, 'date', 'found', 'timestamp')));
    out.outliers = rows.map((r) => ({
      title: col(r, 'title'), channel: col(r, 'channel', 'creator'),
      score: parseFloat(col(r, 'outlier', 'score')) || 0, platform: col(r, 'platform') || '',
    })).sort((a, b) => b.score - a.score).slice(0, 3);
    if (!out.outliers.length) out.empty.push('Daily Outlier (no rows today)');
  });

  await safe('content-calendar', async () => {
    const rows = await readTab(sheets, 'Content Calendar');
    out.calToday = rows.filter((r) => isToday(col(r, 'date')));
    const weekAgo = new Date(Date.now() - 6 * 864e5).toISOString().slice(0, 10);
    const week = rows.filter((r) => { const d = toYmd(col(r, 'date')); return d >= weekAgo && d <= TODAY; });
    out.calWeek = week.length;
    // value:ask ratio — give freely, sell rarely. Posts are tagged VALUE
    // (teaches/entertains, asks nothing) or ASK (sells/pitches). Warn when the
    // week drops under ~6 value posts per ask.
    const types = week.map((r) => col(r, 'type').toUpperCase()).filter((t) => t === 'VALUE' || t === 'ASK');
    if (types.length) {
      const value = types.filter((t) => t === 'VALUE').length, asks = types.filter((t) => t === 'ASK').length;
      out.valueAsk = { value, asks, ratio: asks ? (value / asks).toFixed(1) : '∞', warn: asks > 0 && value / asks < 6 };
    }
  });
  return out;
}

// ---- 5. queue + pipeline log + system health ----
function queueCount() { try { return fs.readdirSync(OUT.queue).filter((f) => f.endsWith('.json')).length; } catch (_) { return 0; } }
function pipelineLines() {
  try {
    const f = path.join(LOG_DIR, 'pipeline-log.txt');
    if (!fs.existsSync(f)) return [];
    return fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.includes(TODAY) && /\b(OK|FAIL)\b/.test(l));
  } catch (_) { return []; }
}
function agentHealth() {
  const out = [];
  try {
    for (const f of fs.readdirSync(LOG_DIR).filter((x) => x.endsWith('-log.txt'))) {
      try {
        const lines = fs.readFileSync(path.join(LOG_DIR, f), 'utf8').trim().split('\n');
        const last = lines[lines.length - 1] || '';
        out.push({ agent: f.replace('-log.txt', ''), last: last.slice(0, 140) });
      } catch (_) {}
    }
  } catch (_) {}
  return out;
}

// ---- plain-language helpers ----
// Turn the internal format tag into something a human understands.
function formatExplain(it) {
  switch (it.format) {
    case 'article':    return 'A long-form article (markdown + HTML in output/articles/), ready to publish on your blog or newsletter.';
    case 'canva-post': return 'A designed visual post built from your Canva template, with caption.';
    case 'repurpose':  return 'A past winner re-angled into a new piece.';
    default:           return 'A platform-native text post — no visual asset needed.';
  }
}
// where this post is going, in plain words
function whereItGoes(it) {
  return (it.platforms || '').replace(/\(\d+\)/g, '').replace(/\s+/g, ' ').trim();
}

// ---- PLAIN-TEXT email (fallback + what shows if HTML is stripped) ----
function buildHumanText(d) {
  const L = [];
  const n = d.content.length;
  const dow = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date().getDay()];
  L.push(`Hi,`, '');
  if (!n) {
    L.push(`Quick check-in: the content engine ran this morning and everything's healthy, but there's nothing new for you to review right now. Enjoy the breathing room.`, '');
  } else {
    L.push(`Here's your ${dow} batch — ${n} ${n === 1 ? 'piece' : 'pieces'} ready for your eyes. Nothing posts until you say go.`, '');
    L.push(`Quick reply guide:`, `  "1 yes"  → approve it`, `  "1 no"   → reject it`, `  "1 change the hook to ..."  → I'll fix it`);
    if (n > 1) L.push(`  (Batch them: "1 yes, 2 no, 3 change...")`);
    L.push('');
    d.content.forEach((it, i) => {
      const num = i + 1;
      const where = whereItGoes(it);
      L.push(`── ${num}. ${it.topic || 'Untitled'} ──`);
      if (where) L.push(`  → ${where}`);
      L.push(`  Format: ${formatExplain(it)}`);
      if (it.hook) L.push(`  Hook: "${it.hook}"`);
      if (it.grade) L.push(`  Grade: ${it.grade}/10${it.gradeVerdict ? ` (${it.gradeVerdict})` : ''}`);
      if (it.caption) L.push(`  Caption preview: ${it.caption}`);
      if (it.path) L.push(`  File: ${it.path}`);
      L.push('');
    });
  }

  if (d.articles.length) {
    L.push(`────────────────────`, '', `ARTICLES WRITTEN TODAY (${d.articles.length})`);
    d.articles.forEach((a) => {
      L.push(`   ${a.title || a.name}`);
      L.push(`   File: ${a.path}`);
    });
    L.push(`Publish them wherever you like — they're plain markdown + HTML.`, '');
  }

  if (d.approvedToday || d.rejectedToday) {
    L.push(`────────────────────`, '', `YOUR CALLS TODAY: approved ${d.approvedToday} · rejected ${d.rejectedToday}`, '');
  }

  // FYI section
  L.push(``, `—`, `FYI (no action needed)`, '');
  if (d.sheets.outliers.length) {
    L.push(`Trending in your niche:`);
    d.sheets.outliers.forEach((o) => L.push(`  • ${o.title} (${o.channel})`));
    L.push('');
  }
  const liveCount = d.sheets.calToday.length || 0;
  L.push(`Going live today: ${liveCount} | In queue: ${d.queueCount}`);
  if (d.sheets.valueAsk) L.push(`Value:ask ratio this week: ${d.sheets.valueAsk.ratio}:1${d.sheets.valueAsk.warn ? ' — below 6:1, ease off the pitches' : ''}`);
  const failed = (d.pipeline || []).filter((l) => /FAIL/.test(l));
  if (failed.length) L.push('', `Heads up: something hiccupped this morning. You'll get a separate alert.`);
  L.push('', `— Your Content Machine`);
  return L.join('\n');
}

// ---- HTML email (human copy, mirrors the plain text) ----
function buildHumanHtml(d) {
  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const n = d.content.length;
  const P = '#2f6f4f', INK = '#1c1a17', SKIN = '#f7f7f5', MUTE = '#84807b';
  const wrap = (inner) => `<!doctype html><html><body style="margin:0;background:${SKIN};font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:${INK};line-height:1.5">
<div style="max-width:600px;margin:0 auto;padding:20px">${inner}</div></body></html>`;

  const dowH = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date().getDay()];
  let h = `<h1 style="font-size:22px;margin:0 0 4px">Hi</h1>`;
  if (!n) {
    h += `<p style="font-size:16px;color:${MUTE}">Quick check-in: the content engine ran this morning and everything's healthy. Nothing new for you to review — enjoy the breathing room.</p>`;
  } else {
    h += `<p style="font-size:16px;margin:0 0 16px">Here's your <strong>${dowH} batch</strong> — ${n} ${n === 1 ? 'piece' : 'pieces'} ready. Nothing posts until you say go.</p>`;
    h += `<div style="background:#fff;border-radius:12px;padding:14px 16px;margin:0 0 18px;font-size:14px;line-height:1.7">
      <strong>Reply guide</strong><br>
      <span style="color:${P};font-weight:600">"1 yes"</span> approve &nbsp;·&nbsp;
      <span style="color:${P};font-weight:600">"1 no"</span> reject &nbsp;·&nbsp;
      <span style="color:${P};font-weight:600">"1 change the hook to …"</span> fix
      ${n > 1 ? `<br><span style="color:${MUTE};font-size:13px">Batch them: "1 yes, 2 no, 3 change…"</span>` : ''}
    </div>`;

    d.content.forEach((it, i) => {
      const num = i + 1;
      const badge = `<span style="background:#eef3ee;color:${P};font-size:12px;font-weight:600;padding:2px 8px;border-radius:20px">${esc(it.format)}</span>`;
      h += `<div style="background:#fff;border-radius:12px;padding:16px;margin:0 0 14px">
        <div style="font-size:13px;color:${MUTE};margin-bottom:6px">POST ${num}${whereItGoes(it) ? ` · going to ${esc(whereItGoes(it))}` : ''}</div>
        ${badge}
        <p style="margin:10px 0 4px;font-size:14px;color:${MUTE}">${esc(formatExplain(it))}</p>
        ${it.hook ? `<p style="margin:8px 0;font-size:16px;font-weight:600">"${esc(it.hook)}"</p>` : ''}
        ${it.grade ? `<p style="margin:6px 0;font-size:13px;color:${MUTE}">post-grader: <strong style="color:${P}">${esc(it.grade)}/10</strong>${it.gradeVerdict ? ` — ${esc(it.gradeVerdict)}` : ''} · top fixes in ${esc(it.file.replace(/\.md$/, '.grade.txt'))}</p>` : ''}
        ${it.caption ? `<p style="margin:6px 0;font-size:14px;color:#555">${esc(it.caption)}</p>` : ''}
        ${it.path ? `<p style="margin:4px 0;font-size:12px;color:${MUTE};word-break:break-all">📁 ${esc(it.path)}</p>` : ''}
        <p style="margin:12px 0 0;font-size:15px">Reply <span style="color:${P};font-weight:600">"${num} yes"</span> to approve, or <span style="color:${P};font-weight:600">"${num} no"</span> to reject.</p>
      </div>`;
    });
  }

  if (d.articles.length) {
    h += `<div style="background:#fff;border-radius:12px;padding:16px;margin:0 0 14px">
      <div style="font-size:13px;color:${MUTE};margin-bottom:6px">ARTICLES WRITTEN TODAY (${d.articles.length})</div>
      ${d.articles.map((a) => `<p style="margin:6px 0;font-size:15px"><strong>${esc(a.title || a.name)}</strong><br><span style="font-size:12px;color:${MUTE};word-break:break-all">${esc(a.path)}</span></p>`).join('')}
      <p style="margin:10px 0 0;font-size:14px;color:${MUTE}">Publish them wherever you like — plain markdown + HTML.</p>
    </div>`;
  }
  if (d.approvedToday || d.rejectedToday) {
    h += `<div style="background:#fff;border-radius:12px;padding:14px 16px;margin:0 0 14px;font-size:14px">
      <strong>Your calls today</strong> — approved ${d.approvedToday} · rejected ${d.rejectedToday}
    </div>`;
  }

  // FYI footer
  let fyi = '';
  if (d.sheets.outliers.length) fyi += `<p style="margin:6px 0"><strong>Trending in your niche:</strong><br>${d.sheets.outliers.map((o) => `• ${esc(o.title)} — ${esc(o.channel)}`).join('<br>')}</p>`;
  fyi += `<p style="margin:6px 0">Live today: ${d.sheets.calToday.length || 0} · In your queue: ${d.queueCount}</p>`;
  if (d.sheets.valueAsk) fyi += `<p style="margin:6px 0">Value:ask this week: ${d.sheets.valueAsk.ratio}:1${d.sheets.valueAsk.warn ? ' — below 6:1, ease off the pitches' : ''}</p>`;
  if ((d.pipeline || []).some((l) => /FAIL/.test(l))) fyi += `<p style="margin:6px 0;color:${P}">Something didn't run cleanly this morning — you'll have a separate alert with the fix.</p>`;
  h += `<div style="border-top:1px solid #e2e0dc;margin-top:18px;padding-top:12px;color:${MUTE};font-size:13px">
    <div style="font-weight:600;margin-bottom:4px">Background — nothing to do here</div>${fyi}</div>`;

  return wrap(h);
}

// ---- dashboard ----
function buildDashboard(d) {
  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const card = (title, inner) => `<section class="card"><h2>${title}</h2>${inner}</section>`;
  const queueHtml = d.content.length
    ? '<ol>' + d.content.map((it) => `<li><strong>${esc(it.topic)}</strong><br><em>"${esc(it.hook)}"</em> — ${esc(it.format)}${it.hookScore ? ` (hook ${esc(it.hookScore)}/10)` : ''}${it.grade ? ` · post-grader ${esc(it.grade)}/10${it.gradeVerdict ? ` ${esc(it.gradeVerdict)}` : ''}` : ''}</li>`).join('') + '</ol>'
    : '<p class="muted">none today</p>';
  const articles = d.articles.length
    ? '<ul>' + d.articles.map((a) => `<li><a href="file://${encodeURI(a.path)}">${esc(a.title || a.name)}</a></li>`).join('') + '</ul>'
    : '<p class="muted">none today</p>';
  const visuals = d.canva.length ? '<div class="thumbs">' + d.canva.map((t) => `<img src="file://${encodeURI(t.path)}" alt="${esc(t.name)}">`).join('') + '</div>' : '<p class="muted">none today</p>';
  const cal = d.sheets.calToday.length ? '<ul>' + d.sheets.calToday.map((r) => `<li>${esc(Object.values(r).filter(Boolean).slice(0, 4).join(' — '))}</li>`).join('') + '</ul>' : '<p class="muted">none scheduled today</p>';
  const health = d.health.length ? '<table>' + d.health.map((x) => `<tr><td>${esc(x.agent)}</td><td>${esc(x.last)}</td></tr>`).join('') + '</table>' : '<p class="muted">no logs</p>';
  const va = d.sheets.valueAsk ? `${d.sheets.valueAsk.ratio}:1 ${d.sheets.valueAsk.warn ? '⚠️ below 6:1' : '✓'}` : 'no Type data';
  const cmds = ['node pipeline.js --once', 'node agents/agent6b-daily-reporter.js --no-email', 'node agents/agent7-analyst.js --run', 'node agents/lane-rotator.js --summary', 'node agents/alerts.js --test']
    .map((c) => `<pre><code>${esc(c)}</code></pre>`).join('');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Daily Digest — ${TODAY}</title>
<style>
:root{--accent:#2f6f4f;--ink:#1c1a17;--bg:#f7f7f5}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,'Segoe UI',sans-serif;padding:16px;max-width:760px;margin-inline:auto}
h1{font-size:1.7rem;margin:.3em 0}h1 span{color:var(--accent)}
h2{font-size:1.05rem;margin:0 0 .5em;color:var(--accent)}
.card{background:#fff;border-radius:14px;padding:16px 18px;margin:12px 0;box-shadow:0 1px 4px rgba(28,26,23,.08)}
.muted{color:#84807b}em{color:var(--accent);font-style:normal;font-weight:500}
.thumbs{display:flex;gap:8px;flex-wrap:wrap}.thumbs img{width:31%;min-width:140px;border-radius:8px}
table{width:100%;border-collapse:collapse;font-size:.85rem}td{padding:5px 8px;border-bottom:1px solid #eee;vertical-align:top}td:first-child{font-weight:700;color:var(--accent);white-space:nowrap}
pre{background:var(--ink);color:var(--bg);padding:8px 12px;border-radius:8px;overflow-x:auto;font-size:.8rem}
a{color:var(--accent)}ol li,ul li{margin:.5em 0}.stat{font-size:1.4rem;font-weight:700;color:var(--accent)}
</style></head><body>
<h1>🌅 Daily Digest <span>${TODAY}</span></h1>
${card("Today's review queue", queueHtml)}
${card('Articles', articles)}
${card('Canva visuals', visuals)}
${card('Posts scheduled today', cal)}
${card('Value : ask ratio (this week)', `<p class="stat">${va}</p>`)}
${card('Approved / rejected today', `<p class="stat">${d.approvedToday} / ${d.rejectedToday}</p>`)}
${card('System health', health)}
${card('Quick run', cmds)}
</body></html>`;
  const out = path.join(DASH_DIR, 'dashboard.html');
  fs.writeFileSync(out, html);
  return out;
}

// ---- compile ----
async function compile() {
  log('================ REPORTER RUN START ================');
  const d = {
    content: await safe('content', async () => gatherContent(), []),
    canva: await safe('canva', async () => gatherCanva(), []),
    articles: await safe('articles', async () => gatherArticles(), []),
    approvedToday: await safe('approved', async () => countToday(OUT.approved), 0),
    rejectedToday: await safe('rejected', async () => countToday(OUT.rejected), 0),
    sheets: await safe('sheets', gatherSheets, { outliers: [], calToday: [], calWeek: 0, valueAsk: null, empty: ['sheets (error)'] }),
    queueCount: queueCount(),
    pipeline: await safe('pipeline', async () => pipelineLines(), []),
    health: await safe('health', async () => agentHealth(), []),
  };

  const dow = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date().getDay()];
  const subject = d.content.length
    ? `${dow}'s batch: ${d.content.length} ${d.content.length === 1 ? 'piece' : 'pieces'} ready for you`
    : `${dow} update — nothing to review, system healthy`;
  const body = await safe('body', async () => buildHumanText(d), 'Daily digest could not be compiled — check reporter-log.txt');
  const html = await safe('html', async () => buildHumanHtml(d), null);
  const dashboardPath = await safe('dashboard', async () => buildDashboard(d), null);
  log(`Compiled: ${d.content.length} content item(s), articles=${d.articles.length}, visuals=${d.canva.length}, dashboard=${dashboardPath}`);
  if (d.sheets.empty.length) log(`Empty data sources: ${d.sheets.empty.join('; ')}`);
  return { subject, body, html, dashboardPath, items: d.content };
}

async function main() {
  const r = await compile();
  if (process.argv.includes('--no-email')) {
    log('--no-email: skipping send.');
    console.log('\n' + r.subject + '\n\n' + r.body);
  } else {
    try {
      const { sendMail } = require('./mailer');
      // The reporter is the ONE consolidated email — bypass pipeline suppression.
      process.env.CM_FORCE_EMAIL = '1';
      await sendMail(r.subject, r.body, { html: r.html, config: CFG });
      log(`Email sent: ${r.subject}`);
      console.log('Email sent');
    } catch (e) {
      logErr('mail', e);
      const f = path.join(LOG_DIR, `reporter-email-${Date.now()}.txt`);
      try { fs.writeFileSync(f, `Subject: ${r.subject}\n\n${r.body}`); log(`Email FAILED — saved ${path.basename(f)}`); } catch (_) {}
    }
  }
  log('================ REPORTER RUN END ================\n');
}

if (require.main === module) main().then(() => process.exit(0)).catch((e) => { logErr('main', e); process.exit(0); });
module.exports = { compile, buildHumanText, buildHumanHtml, formatExplain };
