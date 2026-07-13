#!/usr/bin/env node
/* ============================================================================
 * agent7-analyst.js — weekly performance analyst.
 *
 * Once a week (e.g. Monday morning): pulls the last 7 days of performance
 * (scheduler API + Content Calendar tab), scores posts, finds the top
 * performer, analyzes WHY it worked via Claude, generates 3 new ideas (one per
 * content pillar), appends a Performance Log row, and emails the weekly report.
 *
 * Run:
 *   node agents/agent7-analyst.js --run [--config <path>]
 *
 * Schedule it weekly with cron/launchd (see orchestrator/ — gen-plists).
 *
 * INVARIANT: never crash — ALWAYS send the email even if data is missing.
 * A report that says "no data yet" beats silence (silence is how monitoring
 * failures hide).
 *
 * DRIFT LESSON (kept from the original build): this agent once sliced the
 * first N chars of a large ops file into its prompt. The voice/content rules
 * lived past the slice, so the weekly ideas were generated without ever seeing
 * them — and adding rules made output worse. It now reads the curated canon
 * through brand-context.js, extracted by heading, never by character count.
 * ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const { LOG_DIR, loadConfig, envReader, model, makeLogger } = require('./common');
const log = makeLogger('analyst');
const logErr = log.err;

const CFG = loadConfig();
const env = envReader();
const ANTHROPIC_KEY = env('ANTHROPIC_API_KEY');
const SCHEDULER_KEY = env('SCHEDULER_API_KEY');
const SHEET_ID = (CFG.data && CFG.data.google_sheet_id) || env('GOOGLE_SHEETS_ID');
const MODEL = model(env);

// Content pillars — the 3 recurring themes your ideas rotate through.
// e.g. an urban-gardening account might use:
//   ["Balcony basics", "Behind the scenes", "Harvest stories"]
const PILLARS = (CFG.content && Array.isArray(CFG.content.pillars) && CFG.content.pillars.length)
  ? CFG.content.pillars.slice(0, 3)
  : ['Pillar 1', 'Pillar 2', 'Pillar 3'];

const ymd = () => new Date().toISOString().slice(0, 10);

async function getGoogle(scopes) { const { google } = require('googleapis'); const auth = new google.auth.GoogleAuth({ scopes }); return { google, client: await auth.getClient() }; }

// ---- scheduler last-7-days performance (best effort) ----
async function schedulerLast7() {
  if (!SCHEDULER_KEY) { log('Scheduler: no SCHEDULER_API_KEY — skipping live performance read'); return []; }
  try {
    const res = await fetch('https://backend.blotato.com/v2/schedules?limit=50', { headers: { 'blotato-api-key': SCHEDULER_KEY } });
    if (!res.ok) throw new Error(`Scheduler HTTP ${res.status}`);
    const j = await res.json();
    const items = j.items || j.data || [];
    const weekAgo = Date.now() - 7 * 86400000;
    // "gone live" = scheduledAt in the past 7 days. The scheduler exposes no
    // view/like analytics here, so metrics come back empty (→ Sheets fallback,
    // populated by agent7b-performance.js).
    const live = items.filter((p) => { const t = new Date(p.scheduledAt || p.scheduledTime || 0).getTime(); return t < Date.now() && t > weekAgo; });
    log(`Scheduler: ${items.length} scheduled, ${live.length} went live in last 7 days (no analytics fields exposed)`);
    return live.map((p) => ({ id: p.id, platform: (p.draft && p.draft.target && p.draft.target.targetType) || '', account: (p.account && p.account.username) || '', text: (p.draft && p.draft.content && p.draft.content.text) || '', when: p.scheduledAt, views: 0, likes: 0, comments: 0 }));
  } catch (e) { logErr('scheduler', e); return []; }
}

// ---- Content Calendar (for matching + fallback metrics) ----
async function readSheet(tab, range) {
  if (!SHEET_ID) return [];
  try { const { google, client } = await getGoogle(['https://www.googleapis.com/auth/spreadsheets']); const sheets = google.sheets({ version: 'v4', auth: client }); const r = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${tab}!${range}` }); return r.data.values || []; }
  catch (e) { logErr(`sheet:${tab}`, e); return []; }
}
function rowsToObjs(rows) { const h = rows[0] || []; return rows.slice(1).map((r) => { const o = {}; h.forEach((k, i) => o[k] = r[i] || ''); return o; }); }

const SCORE = (p) => (Number(p.views) || 0) * 1 + (Number(p.likes) || 0) * 3 + (Number(p.comments) || 0) * 10;

// ---- Claude analysis + 3 ideas (tool-use, so output is structured) ----
async function claudeAnalyze(brand, topPerformer, fallbackOutliers) {
  if (!ANTHROPIC_KEY) return null;
  const ctx = topPerformer
    ? `TOP PERFORMER:\nplatform=${topPerformer.platform}\nscore=${SCORE(topPerformer)} (${topPerformer.views}v/${topPerformer.likes}l/${topPerformer.comments}c)\ncontent: ${(topPerformer.text || '').slice(0, 600)}`
    : `NO POSTS WENT LIVE LAST WEEK. Base 3 ideas on these trending outlier posts instead:\n${(fallbackOutliers || []).slice(0, 5).map((o) => `- ${o['Video Title'] || o.Title} (${o.Creator || o.Channel}, score ${o['Outlier Score'] || o.Score})`).join('\n')}`;
  const sys = `You analyze social performance for a content engine. Brand rules:\n${(brand || '').slice(0, 60000)}\nReturn via the emit tool. hookType ∈ myth-bust|confession|mechanism|authority|pattern-interrupt|other. Three ideas, one per pillar in order: ${PILLARS.join(' / ')}; each idea has topic + hook.`;
  const body = {
    model: MODEL, max_tokens: 2000, system: [{ type: 'text', text: sys, cache_control: { type: 'ephemeral' } }],
    tools: [{ name: 'emit', description: 'Emit weekly analysis.', input_schema: { type: 'object', properties: {
      hookType: { type: 'string' }, whatWorked: { type: 'string', description: '2 sentences max' }, topicCategory: { type: 'string' },
      ideas: { type: 'array', items: { type: 'object', properties: { pillar: { type: 'string' }, topic: { type: 'string' }, hook: { type: 'string' } }, required: ['pillar', 'topic', 'hook'] } },
    }, required: ['whatWorked', 'ideas'] } }],
    tool_choice: { type: 'tool', name: 'emit' },
    messages: [{ role: 'user', content: ctx }],
  };
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`Anthropic HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
    const j = await res.json();
    const tu = (j.content || []).find((c) => c.type === 'tool_use');
    if (!tu) throw new Error('no tool_use');
    log('Claude: analysis + 3 ideas generated');
    return tu.input;
  } catch (e) { logErr('anthropic', e); return null; }
}

async function appendPerfLog(week, top, analysis) {
  if (!SHEET_ID) return;
  try {
    const { google, client } = await getGoogle(['https://www.googleapis.com/auth/spreadsheets']);
    const sheets = google.sheets({ version: 'v4', auth: client });
    const ideas = analysis && analysis.ideas ? analysis.ideas.map((i) => `${i.pillar}: ${i.topic}`).join(' | ') : '(none)';
    const row = [week, top ? top.id : 'none', top ? top.platform : '', top ? top.views : '', top ? `${SCORE(top)} score` : '',
      analysis ? (analysis.hookType || '') : '', analysis ? (analysis.topicCategory || '') : '', top ? top.account : '',
      analysis ? (analysis.whatWorked || '') : 'no analysis', ideas];
    await sheets.spreadsheets.values.append({ spreadsheetId: SHEET_ID, range: 'Performance Log!A1', valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', requestBody: { values: [row] } });
    log('Performance Log: row appended');
  } catch (e) { logErr('perflog', e); }
}

async function sendReport(subject, body) {
  try { const { sendMail } = require('./mailer'); const id = await sendMail(subject, body, { config: CFG }); log(`Email: weekly report sent (${id})`); }
  catch (e) { logErr('mail', e); const f = path.join(LOG_DIR, `weekly-report-${ymd()}.txt`); fs.writeFileSync(f, `Subject: ${subject}\n\n${body}`); log(`Email FAILED — saved ${path.basename(f)}`); }
}

// ---- main analysis ----
async function runAnalysis() {
  log('================ WEEKLY ANALYST RUN START ================');
  // Curated voice/content canon via heading extraction — never a char-slice.
  const brand = (() => { try { const bc = require('./brand-context'); return bc.buildBrandContext({ voice: '', hooks: '', contentDoc: bc.loadContentDoc() }); } catch (_) { return ''; } })();
  const week = `Week of ${ymd()}`;

  // 1. performance from the scheduler; match to Content Calendar
  let live = await schedulerLast7();
  const cal = rowsToObjs(await readSheet('Content Calendar', 'A1:O500'));
  // fallback metrics from Content Calendar if the scheduler had none
  if (!live.length && cal.length) {
    live = cal.filter((c) => (c.Status || '').toLowerCase() === 'scheduled' || c.Views).map((c) => ({ id: c['Schedule ID'] || c['Post ID'], platform: c.Platform, account: c['Account ID'], text: c['Caption Preview'], views: c.Views, likes: c.Likes, comments: c.Comments }));
  }
  // only count posts that actually have metrics as "performance"
  const withMetrics = live.filter((p) => (Number(p.views) || 0) + (Number(p.likes) || 0) + (Number(p.comments) || 0) > 0);

  let top = null, fallbackOutliers = null;
  if (withMetrics.length) {
    top = withMetrics.sort((a, b) => SCORE(b) - SCORE(a))[0];
    log(`Top performer: ${top.id} score ${SCORE(top)} (${top.views}v/${top.likes}l/${top.comments}c)`);
  } else {
    log('No performance data yet (first-week / no analytics) — falling back to Daily Outlier tab for ideas.');
    fallbackOutliers = rowsToObjs(await readSheet('Daily Outlier', 'A1:N100'));
  }

  // 2. Claude analysis + 3 ideas
  const analysis = await claudeAnalyze(brand, top, fallbackOutliers);

  // 3. Performance Log row
  await appendPerfLog(week, top, analysis);

  // 4. weekly report email
  const subject = `📊 Weekly Report — ${week}`;
  let body = '';
  if (top) {
    body += `LAST WEEK TOP PERFORMER:\nPlatform: ${top.platform}\nHook: ${(top.text || '').slice(0, 100)}\nScore: ${SCORE(top)} (${top.views}v / ${top.likes}l / ${top.comments}c)\nWhat worked: ${analysis ? analysis.whatWorked : '(analysis unavailable)'}\n\n`;
  } else {
    body += `LAST WEEK TOP PERFORMER:\n(No posts had performance data yet — ideas below are modeled on this week's top outlier posts.)\n\n`;
  }
  body += `THREE IDEAS FOR THIS WEEK:\n`;
  if (analysis && analysis.ideas) {
    PILLARS.forEach((p, idx) => {
      const idea = analysis.ideas.find((i) => (i.pillar || '').toLowerCase().includes(p.toLowerCase())) || analysis.ideas[idx];
      if (idea) body += `${p}: ${idea.topic} — Hook: "${idea.hook}"\n`;
    });
  } else {
    body += `(Claude analysis unavailable — raw metrics only. Re-run when ANTHROPIC_API_KEY is set.)\n`;
  }
  const scheduledThisWeek = cal.filter((c) => (c.Status || '').toLowerCase() === 'scheduled').length;
  const nextPost = cal.filter((c) => (c.Status || '').toLowerCase() === 'scheduled').sort((a, b) => `${a.Date}${a['Time UTC']}`.localeCompare(`${b.Date}${b['Time UTC']}`))[0];
  body += `\nCONTENT CALENDAR STATUS:\nPosts scheduled this week: ${scheduledThisWeek}\nNext post going live: ${nextPost ? `${nextPost.Date} ${nextPost['Time UTC']} UTC ${nextPost.Platform}` : '(none scheduled)'}\n\n`;
  body += `To produce any of these: run the pipeline with the idea as a manual topic (config.topics.manual_topics).\n`;
  await sendReport(subject, body);

  log('================ WEEKLY ANALYST RUN END ================\n');
  return { subject, body, analysis, top };
}

if (require.main === module) runAnalysis().then(() => process.exit(0)).catch((e) => { logErr('main', e); process.exit(0); });
module.exports = { runAnalysis, SCORE };
