#!/usr/bin/env node
/* ============================================================================
 * APPROVAL HANDLER — the human gate between drafts and the internet.
 *
 * ⛔ HARD INVARIANT — the entire safety model, in three lines:
 *   1. agent5-scheduler.js is the ONLY file that publishes (calls the
 *      scheduler backend's publish endpoint).
 *   2. THIS file is the ONLY thing that invokes agent5 in "approve" mode —
 *      and it only does so on YOUR explicit email reply.
 *   3. With config.approval.mode = "approve" (the default), nothing is ever
 *      scheduled without that reply. No timer, no batch job, no fallback path.
 *
 * How it works:
 *   --send-review   email you today's pending packages, numbered, with reply
 *                   instructions (pipeline.js calls this at the end of a run)
 *   --once          poll the approval inbox once and act on any replies
 *   --watch         stay resident and poll continuously (launchd/systemd)
 *   All flags accept --config <path> (default config/config.json).
 *
 * Reply commands (case-insensitive; date prefix like "jun15" scopes older days):
 *   "1 yes" / "approve 1" / "approve all"  → schedule that package (agent5)
 *   "1 no"  / "skip 1"                     → decline; archive to output/rejected/
 *   "1 change <note>" / "edit 1 <note>"    → rewrite via the writer agent
 *   "status"                               → email the full pending queue
 *   "note: <anything>"                     → captured as feedback, never an action
 *   CANVA-APPROVED-<POST-ID> <url>         → attach the finished visual + schedule
 *   CANVA-REJECT-<POST-ID>                 → regenerate the visual brief
 *   CANVA-EDIT-<POST-ID> <notes>           → new brief version with your notes
 *
 * Anything that isn't a recognized command is saved to logs/feedback.txt —
 * free-text notes are never mistaken for approvals.
 *
 * State: logs/approval-state.json (processed message ids). Never crashes.
 * ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { OUT, LOG_DIR, ensureOutputDirs, configPath, loadConfig, makeLogger, ts, todayLocal } = require('./common');

const log = makeLogger('approval');
const CFG = loadConfig();
const CONFIG_PATH = configPath();
ensureOutputDirs();

const STATE_FILE = path.join(LOG_DIR, 'approval-state.json');
const FEEDBACK_FILE = path.join(LOG_DIR, 'feedback.txt');
const CANVA_DIR = path.join(OUT.pending, 'canva');
const CANVA_BRIEFS = path.join(CANVA_DIR, 'briefs');

const APPROVAL_EMAIL = (CFG.approval && CFG.approval.approval_channel_email) || '';
const MODE = (CFG.approval && CFG.approval.mode) || 'approve';

async function notify(subject, body) {
  try { const { sendMail } = require('./mailer'); await sendMail(subject, body, { config: CFG }); log(`Email sent: ${subject}`); }
  catch (e) { log.err('email', e); }
}

// ---- state ----
function loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (_) { return { gmail: [] }; } }
function saveState(s) { try { s.gmail = (s.gmail || []).slice(-500); fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch (e) { log.err('state', e); } }

// ---- active window (optional) ----
// config.approval.active_hours = { "start": 6, "end": 22, "timezone": "America/New_York" }
// Outside the window the poller idles (no replies processed, no emails sent).
// Omit the block entirely to run around the clock.
function inActiveWindow() {
  const w = (CFG.approval && CFG.approval.active_hours) || null;
  if (!w) return true;
  const opts = { hour: 'numeric', hour12: false };
  if (w.timezone) opts.timeZone = w.timezone;
  const h = parseInt(new Intl.DateTimeFormat('en-US', opts).format(new Date()), 10);
  return h >= (w.start ?? 0) && h < (w.end ?? 24);
}

// ---- pending packages (numbered the same way the review email numbers them) ----
const ymd = todayLocal;
// A package's batch date = the date IN ITS FILENAME (…YYYY-MM-DD…), which is
// stable. Falling back to file mtime made status() and approveN() DISAGREE —
// a file touched near midnight got an mtime that didn't match its filename
// date, so the review listed "1. …" while "1 yes" replied "nothing waiting."
function fileDate(f) {
  const m = f.match(/(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  try { return fs.statSync(path.join(OUT.pending, f)).mtime.toISOString().slice(0, 10); } catch (_) { return 'unknown'; }
}
let scopedPending = null; // set while a date-prefixed command is in flight
function todaysPending(forDate) {
  if (!forDate && scopedPending) return scopedPending.files;
  const target = forDate || ymd();
  try {
    return fs.readdirSync(OUT.pending)
      .filter((f) => f.endsWith('.md') && !f.startsWith('.'))
      .filter((f) => fileDate(f) === target)
      .sort();
  } catch (_) { return []; }
}
function parsePkg(file) {
  const txt = fs.readFileSync(path.join(OUT.pending, file), 'utf8');
  const h1 = txt.match(/^#\s*(?:Content Package\s*[—-]\s*)?(.+)$/m);
  return { topic: (h1 ? h1[1] : file.replace(/\.md$/, '')).trim(), file };
}
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);

function run(cmd) {
  log(`SPAWN: ${cmd}`);
  try { execSync(cmd, { cwd: path.resolve(__dirname, '..'), stdio: 'pipe', shell: '/bin/bash', timeout: 30 * 60 * 1000 }); return true; }
  catch (e) { log.err(`spawn:${cmd.slice(0, 60)}`, e); return false; }
}

// ---- date-prefix parser ----
// Handles: "jun15", "june 15th", "july 13,", "monday", "yesterday", "2026-06-15"
// Returns { date: "YYYY-MM-DD", rest: "remainder" } or null.
function parseDatePrefix(text) {
  let t = (text || '').trim().replace(/\b(\d+)(?:st|nd|rd|th)\b/gi, '$1'); // "15th"→"15"
  const now = new Date();
  const today = ymd();
  let m;
  // ISO date: "2026-06-15 ..."
  m = t.match(/^(\d{4}-\d{2}-\d{2})[,\s]\s*([\s\S]+)/i);
  if (m) return { date: m[1], rest: m[2].trim() };
  // "yesterday ..."
  m = t.match(/^yesterday[,\s]\s*([\s\S]+)/i);
  if (m) { const d = new Date(now); d.setDate(d.getDate() - 1); return { date: d.toISOString().slice(0, 10), rest: m[1].trim() }; }
  // Weekday: "monday ...", "mon ..."
  const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const DAYS_SHORT = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  m = t.match(/^(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|wed|thu|fri|sat)[,\s]\s*([\s\S]+)/i);
  if (m) {
    const name = m[1].toLowerCase();
    const idx = DAYS.indexOf(name) !== -1 ? DAYS.indexOf(name) : DAYS_SHORT.indexOf(name);
    const d = new Date(now); const diff = (d.getDay() - idx + 7) % 7 || 7; d.setDate(d.getDate() - diff);
    return { date: d.toISOString().slice(0, 10), rest: m[2].trim() };
  }
  // Month + day: "jun15", "june 15", "july 13,"
  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
    january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
  m = t.match(/^(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s*(\d{1,2})[,\s]\s*([\s\S]+)/i);
  if (m) {
    const mo = MONTHS[m[1].toLowerCase()]; const dy = parseInt(m[2], 10); const yr = parseInt(today.slice(0, 4), 10);
    const candidate = `${yr}-${String(mo).padStart(2, '0')}-${String(dy).padStart(2, '0')}`;
    // Only roll back to last year if the date is >30 days in the future — the
    // queue only ever references recent or upcoming posts.
    const daysAhead = (Date.parse(candidate) - Date.parse(today)) / 86400000;
    const final = daysAhead > 30 ? `${yr - 1}-${String(mo).padStart(2, '0')}-${String(dy).padStart(2, '0')}` : candidate;
    return { date: final, rest: m[3].trim() };
  }
  return null;
}

// ---- natural-language expander ----
// Normalizes messages like "approve july 15th post 1, 2 and 3" or
// "july 13, post 1 edit: fix the hook" into canonical command strings that
// handleOne already understands. Returns an array, or null if unsure.
function expandNL(rawText) {
  // Guard: if each comma/and segment already has its own verb ("1 yes, 2 no"),
  // the fast-path in handleMessage handles it — don't expand here.
  const simple = /^#?\d+\s*[:.\-]*\s*(?:yes|yep|yeah|yay|yup|ok(?:ay)?|sure|approve|go|do\s+it|ship|no|nope|nah|skip|pass|drop|reject|decline)\s*$/i;
  const rawSegs = rawText.trim().split(/\s*(?:,|;|\/|\band\b|\n|&|\+)\s*/i).map((s) => s.trim()).filter(Boolean);
  if (rawSegs.length > 1 && rawSegs.every((s) => simple.test(s))) return null;

  let t = rawText.trim().replace(/\b(\d+)(?:st|nd|rd|th)\b/gi, '$1');

  // Extract edit note FIRST (edit notes can contain numbers)
  let editNote = null;
  const editM = t.match(/\bedit(?:\s+note)?\s*[:\-—]\s*([\s\S]+)$/i) || t.match(/\bchange\s*[:\-—]\s*([\s\S]+)$/i);
  if (editM) { editNote = editM[1].trim(); t = t.slice(0, editM.index).trim(); }

  // Leading action verb (before the date — handles "approve july 15th ...")
  let verbType = null;
  const VERB_MAP = [
    [/^(?:approve|green[\s-]*light|schedule|publish|post|ship)\b/i, 'approve'],
    [/^(?:yes|yep|yeah|yup|ok(?:ay)?)\b/i, 'approve'],
    [/^(?:no|nope|nah|skip|pass|drop|decline|reject)\b/i, 'skip'],
  ];
  for (const [re, vt] of VERB_MAP) {
    const vm = t.match(re);
    if (vm) { t = t.slice(vm[0].length).trim(); verbType = vt; break; }
  }

  // Date prefix from whatever remains ("july 13, post 1 ...")
  const tForDate = t.replace(/^((?:\w+\s*)?\d+)\s*,\s*/, '$1 ');
  const dateCtx = parseDatePrefix(tForDate);
  let datePrefix = '';
  if (dateCtx) { datePrefix = dateCtx.date + ' '; t = dateCtx.rest; }

  // "post(s)" here is a noun ("approve post 1"), strip it
  t = t.replace(/^posts?\s+/i, '');

  // Post numbers
  const numStr = t.replace(/\band\b/gi, ',').replace(/[,;\s]+/g, ',');
  const nums = numStr.split(',').map((s) => s.trim()).filter((s) => /^\d+$/.test(s)).map(Number);
  if (!nums.length) return null;

  // Trivially simple "N verb" → let handleOne take it directly
  if (nums.length === 1 && !datePrefix && !editNote && !verbType) return null;

  return nums.map((n) => {
    if (editNote) return `${datePrefix}${n} change ${editNote}`;
    if (verbType === 'skip') return `${datePrefix}${n} no`;
    return `${datePrefix}${n} yes`;
  });
}

// ---- actions ----

// APPROVE — the one and only path to publishing. Invokes agent5 (the only
// publisher) for this package; agent5 schedules and archives it to
// output/approved/. If the Canva step produced a visual for this package,
// it's attached automatically.
function findVisual(slug) {
  try {
    const pngs = fs.readdirSync(CANVA_DIR)
      .filter((f) => /\.(png|jpe?g|webp)$/i.test(f) && f.toLowerCase().includes(slug.slice(0, 20)))
      .sort((a, b) => fs.statSync(path.join(CANVA_DIR, b)).mtimeMs - fs.statSync(path.join(CANVA_DIR, a)).mtimeMs);
    return pngs.length ? path.join(CANVA_DIR, pngs[0]) : null;
  } catch (_) { return null; }
}

async function approveN(n, source) {
  const files = todaysPending();
  const file = files[n - 1];
  if (!file) {
    log(`APPROVE-${n} (${source}): no pending package #${n} today (${files.length} found)`);
    await notify(`Hmm — I don't see a #${n} for today`, `I couldn't find #${n} in today's batch. Here's what's waiting: ${files.map((f) => parsePkg(f).topic).join(', ') || 'nothing right now'}. Want to try a different number, or reply "status"?`);
    return;
  }
  const pkg = parsePkg(file);
  const slug = slugify(pkg.topic);
  const media = findVisual(slug);
  const dry = process.env.CM_SCHEDULER_DRY === '1' ? ' --dry-run' : '';
  const mediaFlag = media ? ` --media "${media}"` : '';
  log(`APPROVE-${n} (${source}): scheduling "${pkg.topic}"${media ? ` with visual ${path.basename(media)}` : ' (no visual found — text platforms only)'}`);
  const ok = run(`node agents/agent5-scheduler.js${dry} --config "${CONFIG_PATH}" --content "${pkg.topic.replace(/"/g, '')}"${mediaFlag}`);
  if (ok) {
    await notify(`✅ "${pkg.topic}" is scheduled — on its way out`, `Approved and handed to the scheduler.${media ? `\nVisual attached: ${path.basename(media)}` : '\n(No visual found — media platforms were skipped; text platforms scheduled.)'}\n\nThe scheduler's own confirmation email has the exact slots.`);
  } else {
    await notify(`⚠️ "${pkg.topic}" — scheduling hit an error`, 'The scheduler run failed; the package is still in output/pending/ so nothing is lost. Check logs/scheduler-log.txt and reply the same approval to retry.');
  }
}

async function declineN(n, source) {
  const files = todaysPending();
  const file = files[n - 1];
  if (!file) { log(`DECLINE-${n} (${source}): no pending package #${n}`); await notify(`⚠️ Skip #${n}: nothing found`, `Pending today: ${files.join(', ') || 'none'}`); return; }
  const dest = path.join(OUT.rejected, `DECLINED-${ymd()}-${file}`);
  try { fs.renameSync(path.join(OUT.pending, file), dest); } catch (e) { log.err('decline:rename', e); return; }
  log(`DECLINE-${n} (${source}): moved → output/rejected/${path.basename(dest)} | nothing scheduled`);
  // Best-effort: archive the related canva files too
  const slug = slugify(parsePkg2(dest).topic || file);
  for (const dir of [CANVA_DIR, CANVA_BRIEFS]) {
    try { fs.readdirSync(dir).filter((f) => f.toLowerCase().includes(slug.slice(0, 20))).forEach((f) => fs.renameSync(path.join(dir, f), path.join(OUT.rejected, `DECLINED-${ymd()}-${f}`))); } catch (_) {}
  }
  await notify(`👍 Set #${n} aside — nothing posted`, `No problem — I've passed on #${n}. Nothing went out.`);
}
// parsePkg for a file that's already been moved out of pending
function parsePkg2(fullPath) {
  try {
    const txt = fs.readFileSync(fullPath, 'utf8');
    const h1 = txt.match(/^#\s*(?:Content Package\s*[—-]\s*)?(.+)$/m);
    return { topic: h1 ? h1[1].trim() : path.basename(fullPath, '.md') };
  } catch (_) { return { topic: '' }; }
}

async function editN(n, note, source) {
  const files = todaysPending();
  const file = files[n - 1];
  const topic = file ? parsePkg(file).topic : `package #${n}`;
  log(`EDIT-${n} (${source}): "${note}" | topic="${topic}"`);
  // Log the note so the writer can learn from rejections over time
  try { fs.appendFileSync(path.join(LOG_DIR, 'rejection-log.jsonl'), JSON.stringify({ ts: ts(), topic, note, file: file || null }) + '\n'); } catch (_) {}
  run(`node agents/agent3-writer.js --config "${CONFIG_PATH}" --brief "REVISION of ${topic.replace(/"/g, '')}: ${note.replace(/"/g, '')}"`);
  await notify(`✏️ Reworked "${topic}" — have a look`, `Done — I rewrote it with your note: "${note}".\n\nIt's in output/pending/. When it's right, reply "approve ${n}" and it will be scheduled.`);
}

// ---- status: list all pending files grouped by date ----
async function sendStatus() {
  try {
    const all = fs.readdirSync(OUT.pending)
      .filter((f) => f.endsWith('.md') && !f.startsWith('.'))
      .map((f) => ({ date: fileDate(f), topic: parsePkg(f).topic, file: f }))
      .sort((a, b) => a.date.localeCompare(b.date) || a.file.localeCompare(b.file));
    if (!all.length) { await notify('Queue is empty', 'Nothing pending right now.'); return; }
    const byDate = {};
    all.forEach((item) => { (byDate[item.date] = byDate[item.date] || []).push(item); });
    const today = ymd();
    let msg = 'Pending posts:\n\n';
    for (const [date, items] of Object.entries(byDate)) {
      msg += `${date === today ? `Today (${date})` : date}\n`;
      items.forEach((item, i) => { msg += `  ${i + 1}. ${item.topic}\n`; });
      msg += `  → Reply "${date === today ? '' : date + ' '}1 yes" to approve, "${date === today ? '' : date + ' '}1 no" to skip\n\n`;
    }
    msg += 'Use a date prefix for older days — e.g. "jun14 1 yes" or "yesterday 2 no"';
    await notify('📋 Pending queue', msg.trim());
    log('STATUS: sent pending summary');
  } catch (e) { log.err('sendStatus', e); }
}

// ---- --send-review: the review email the pipeline sends after each run ----
async function sendReview() {
  const files = todaysPending();
  if (!files.length) { log('--send-review: nothing pending today — no email sent.'); return; }
  let body = `${files.length} piece(s) ready for your review:\n\n`;
  files.forEach((f, i) => {
    body += `  ${i + 1}. ${parsePkg(f).topic}\n     ${path.join(OUT.pending, f)}\n`;
    const visual = findVisual(slugify(parsePkg(f).topic));
    if (visual) body += `     visual: ${visual}\n`;
  });
  body += '\nReply to this email with:\n'
    + '  "1 yes"             — approve + schedule\n'
    + '  "1 no"              — skip it (archived, nothing posts)\n'
    + '  "1 change <note>"   — request a rewrite\n'
    + '  "approve all"       — approve everything above\n'
    + '  "status"            — see the full queue\n'
    + '\nNothing is scheduled until you reply.';
  if (MODE === 'auto') body += '\n\nNote: config.approval.mode is "auto" — graded content also schedules automatically; this email is informational.';
  await notify(`Review: ${files.length} piece(s) waiting — reply to approve`, body);
  log(`--send-review: emailed ${files.length} pending piece(s) to ${APPROVAL_EMAIL || 'MAIL_SENDER'}`);
}

// ---- command parsing ----
async function handleMessage(text, source) {
  const t = (text || '').trim();
  if (!t) return false;

  // Fast path: each segment carries its own verb ("1 yes, 2 no")
  const simple = /^#?\d+\s*[:.\-]*\s*(?:yes|yep|yeah|yay|yup|ok(?:ay)?|sure|approve|go|do\s+it|ship|no|nope|nah|skip|pass|drop|reject|decline)\s*$/i;
  const segs = t.split(/\s*(?:,|;|\/|\band\b|\n|&|\+)\s*/i).map((s) => s.trim()).filter(Boolean);
  if (segs.length > 1 && segs.every((s) => simple.test(s))) {
    let any = false;
    for (const s of segs) { if (await handleOne(s, source)) any = true; }
    return any;
  }

  // Natural-language expansion: "approve july 15th post 1, 2 and 3"
  const expanded = expandNL(t);
  if (expanded) {
    log(`NL-expand: "${t.slice(0, 80)}" → [${expanded.map((s) => `"${s}"`).join(', ')}]`);
    let any = false;
    for (const cmd of expanded) { if (await handleOne(cmd, source)) any = true; }
    return any;
  }

  return handleOne(t, source);
}

async function handleOne(text, source) {
  const t = (text || '').trim();
  if (!t) return false;

  // ---- status ----
  if (/^\s*(?:status|queue|pending|what(?:'s|\s+is)?\s+pending|show\s+(?:all\s+)?(?:pending|queue)|list\s+(?:pending|posts))\s*$/i.test(t)) {
    await sendStatus(); return true;
  }

  // ---- explicit FEEDBACK: "note: ...", "feedback ...", "fyi ...", "comment ..." ----
  // The reliable way to leave a note — always captured + acked, never mistaken
  // for an action.
  const fbMatch = t.match(/^\s*(?:note|feedback|fyi|comment)\b[:,\-\s]+([\s\S]+)/i);
  if (fbMatch) {
    const note = fbMatch[1].trim();
    try { fs.appendFileSync(FEEDBACK_FILE, `[${ts()}] ${note}\n`); } catch (e) { log.err('feedback-cmd', e); }
    log(`FEEDBACK (explicit, ${source}): "${note.slice(0, 160)}"`);
    await notify('📝 Noted', `Saved: "${note.slice(0, 120)}${note.length > 120 ? '…' : ''}"\n\nNothing was scheduled.`);
    return true;
  }

  // ---- date-scoped commands: "jun15 1 yes", "monday 2 no", "yesterday 1 change ..." ----
  const dateCtx = parseDatePrefix(t);
  if (dateCtx) {
    const scopedFiles = todaysPending(dateCtx.date);
    if (scopedFiles.length) {
      const prev = scopedPending;
      scopedPending = { date: dateCtx.date, files: scopedFiles };
      const result = await handleOne(dateCtx.rest, source);
      scopedPending = prev;
      return result;
    }
    // No files for that date — fall through (gives a natural "nothing found")
  }

  let m;
  // ---- approve all ----
  if (/^\s*(?:(?:ok(?:ay)?|yes|yeah|sure|please|let'?s|go ahead|alright)[,!.\s]+)*(?:approve|post|ship|publish|schedule|green[\s-]*light|do)[\s-]*all\b/i.test(t)) {
    log(`APPROVE-ALL (${source})`);
    const files = todaysPending();
    for (let i = 1; i <= files.length; i++) await approveN(i, source);
    if (!files.length) await notify('Nothing pending right now', 'No posts are waiting for approval today.');
    return true;
  }
  // ---- NUMBER-FIRST replies — the natural way to answer the review email:
  //      "1 yes", "2 no", "1 change the hook to ...". Edit is checked first so
  //      "1 change ..." is never mistaken for an approval. ----
  if ((m = t.match(/^\s*#?(\d+)\s*[:.\-]*\s*(?:change|edit|tweak|fix|rewrite|reword|shorten|lengthen|swap|replace|redo|adjust|make\s+it)\b\s*([\s\S]+)/i))) {
    const note = (m[2] || '').split(/\n--|\nOn .+wrote:/)[0].trim();
    if (note && parseInt(m[1], 10) <= 30) { await editN(parseInt(m[1], 10), note, source); return true; }
  }
  if ((m = t.match(/^\s*#?(\d+)\s*[:.\-]*\s*(?:no|nope|nah|skip|pass|drop|reject|decline)\b/i))) {
    if (parseInt(m[1], 10) <= 30) { await declineN(parseInt(m[1], 10), source); return true; }
  }
  if ((m = t.match(/^\s*#?(\d+)\s*[:.\-]*\s*(?:yes|yep|yeah|yay|yup|ok(?:ay)?|sure|approve|go|do\s+it|ship|send\s+it|👍|✅)\b/i))) {
    if (parseInt(m[1], 10) <= 30) { await approveN(parseInt(m[1], 10), source); return true; }
  }

  // ---- SINGLE-ITEM SHORTCUT ----
  // When exactly ONE post is pending today, a bare yes/no with no number acts
  // on it — no hunting for the right number on a single-item day.
  {
    const pend = todaysPending();
    if (pend.length === 1) {
      if (/^\s*(?:no|nope|nah|skip|pass|drop|reject|decline|not?\s+this)\s*[.!]*\s*$/i.test(t)) { await declineN(1, source); return true; }
      if (/^\s*(?:yes|yep|yeah|yup|ya|ok(?:ay)?|sure|approve(?:\s+it)?|go(?:\s+ahead)?|do\s+it|ship\s+it|sounds?\s+good|👍|✅)\s*[.!]*\s*$/i.test(t)) { await approveN(1, source); return true; }
    }
  }

  // ---- verb-first: "approve 1", "yes 2", "go with 3" ----
  if ((m = t.match(/^\s*(?:(?:ok(?:ay)?|yes|yeah|sure|please|let'?s|go ahead|alright)[,!.\s]+)*(?:approve|schedule|publish|post|ship|green[\s-]*light|yes(?:\s+to)?|go(?:\s+with)?)\b[\s#-]*(\d+)\b/i))) {
    await approveN(parseInt(m[1], 10), source); return true;
  }
  // ---- EDIT (keyword-first): "edit 2 note", "edit: note" ----
  if ((m = t.match(/^\s*(?:(?:ok(?:ay)?|yes|yeah|sure|please)[,!.\s]+)*EDIT\b[\s>:#.\-]*(\d+)?[\s>:.\-]*([\s\S]+)/i))) {
    const note = (m[2] || '').split(/\n--|\nOn .+wrote:/)[0].trim();
    let n = m[1] ? parseInt(m[1], 10) : 0;
    if (!n) { const files = todaysPending(); n = files.length ? 1 : 0; log(`EDIT (no number given, ${source}) — defaulting to #1 of ${files.length} pending`); }
    if (note && n) { await editN(n, note, source); return true; }
  }
  // ---- skip: "skip 1", "pass 2", "no 3" ----
  if ((m = t.match(/^\s*(?:(?:ok(?:ay)?|yes|yeah|sure|please)[,!.\s]+)*(?:decline|reject|skip|pass|drop|no)\b[\s#-]*(\d+)\b/i))) {
    await declineN(parseInt(m[1], 10), source); return true;
  }

  // ---- CANVA-APPROVED-<POST-ID> <url>: wire the finished visual in + schedule ----
  if ((m = t.match(/\bCANVA-APPROVED?-([a-z0-9-]+)\s+(https?:\/\/\S+)/i))) {
    const postId = m[1], assetUrl = m[2].trim();
    log(`CANVA-APPROVED (${source}): postId=${postId} url=${assetUrl}`);
    const briefFile = (() => { try { return fs.readdirSync(CANVA_BRIEFS).find((f) => f === `canva_brief_${postId}.json`); } catch (_) { return null; } })();
    if (briefFile) {
      const briefPath = path.join(CANVA_BRIEFS, briefFile);
      const brief = JSON.parse(fs.readFileSync(briefPath, 'utf8'));
      brief.assetUrl = assetUrl;
      brief.approvedAt = ts();
      fs.writeFileSync(briefPath, JSON.stringify(brief, null, 2));
      log(`  Brief updated with asset URL: ${briefFile}`);
      const dry = process.env.CM_SCHEDULER_DRY === '1' ? ' --dry-run' : '';
      const topic = brief.slides && brief.slides[0] ? brief.slides[0].headline : postId;
      run(`node agents/agent5-scheduler.js${dry} --config "${CONFIG_PATH}" --content "${topic.replace(/"/g, '')}" --media "${assetUrl}"`);
      await notify(`✅ Visual approved + scheduled — ${postId}`, `Asset: ${assetUrl}\nTemplate type: ${brief.templateType}\nPlatform: ${brief.platform}`);
    } else {
      await notify(`⚠️ CANVA-APPROVED: no brief found for ${postId}`, `Looked for canva_brief_${postId}.json in output/pending/canva/briefs/ — not found.`);
    }
    return true;
  }
  // ---- CANVA-REJECT-<POST-ID>: archive brief, regenerate with the router ----
  if ((m = t.match(/\bCANVA-REJECT-([a-z0-9-]+)\b/i))) {
    const postId = m[1];
    log(`CANVA-REJECT (${source}): postId=${postId}`);
    const briefFile = (() => { try { return fs.readdirSync(CANVA_BRIEFS).find((f) => f === `canva_brief_${postId}.json`); } catch (_) { return null; } })();
    if (briefFile) {
      fs.renameSync(path.join(CANVA_BRIEFS, briefFile), path.join(OUT.rejected, `REJECTED-${briefFile}`));
      log(`  Rejected brief archived: ${briefFile}`);
      // Find the source package and regenerate the brief
      const pkgFile = (() => { try { return fs.readdirSync(OUT.pending).find((f) => f.endsWith('.md') && f.includes(postId.replace(/^\d{4}-\d{2}-\d{2}-/, ''))); } catch (_) { return null; } })();
      if (pkgFile) {
        const canva = require('./agent3c-canva');
        await canva.processPkg(canva.parsePkg(path.join(OUT.pending, pkgFile)));
        await notify(`🔄 Visual rejected — new brief generated for ${postId}`, 'A fresh brief was written; the next canva-produce run will rebuild it.');
      } else {
        await notify(`🔄 Visual rejected — ${postId}`, 'Brief archived, but the source package was not found in output/pending/ so no new brief was generated.');
      }
    } else {
      await notify(`⚠️ CANVA-REJECT: no brief found for ${postId}`, `Looked for canva_brief_${postId}.json — not found.`);
    }
    return true;
  }
  // ---- CANVA-EDIT-<POST-ID> <notes>: write a new brief version with notes ----
  if ((m = t.match(/\bCANVA-EDIT-([a-z0-9-]+)\s+([\s\S]+)/i))) {
    const postId = m[1], notes = m[2].split(/\n--|\nOn .+wrote:/)[0].trim();
    log(`CANVA-EDIT (${source}): postId=${postId} notes="${notes.slice(0, 100)}"`);
    const briefFile = (() => { try { return fs.readdirSync(CANVA_BRIEFS).find((f) => f === `canva_brief_${postId}.json`); } catch (_) { return null; } })();
    if (briefFile) {
      const brief = JSON.parse(fs.readFileSync(path.join(CANVA_BRIEFS, briefFile), 'utf8'));
      brief.editNotes = notes;
      const editPath = path.join(CANVA_BRIEFS, `canva_brief_${postId}_edit${Date.now().toString(36)}.json`);
      fs.writeFileSync(editPath, JSON.stringify(brief, null, 2));
      log(`  Edit brief written: ${editPath}`);
      await notify(`📝 Visual edit noted — ${postId}`, `Edit notes: ${notes}\nUpdated brief: ${editPath}\nThe next canva-produce run rebuilds it.`);
    } else {
      await notify(`⚠️ CANVA-EDIT: no brief found for ${postId}`, `Looked for canva_brief_${postId}.json — not found.`);
    }
    return true;
  }
  return false;
}

// ---- inbox polling ----
// Only picks up emails whose subject starts with "Re:" — this cleanly separates
// your replies from system-sent emails (review, confirmations), which always
// have fresh subjects. Zero risk of processing our own mail.
function _extractGmailText(payload) {
  if (!payload) return null;
  if (payload.mimeType === 'text/plain' && payload.body && payload.body.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf8');
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      const t = _extractGmailText(part);
      if (t) return t;
    }
  }
  return null;
}
async function pollInbox(state) {
  try {
    const { google } = require('googleapis');
    const auth = new google.auth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/gmail.readonly'] });
    const gmail = google.gmail({ version: 'v1', auth: await auth.getClient() });
    const fromFilter = APPROVAL_EMAIL ? `from:${APPROVAL_EMAIL} ` : 'from:me ';
    const res = await gmail.users.messages.list({
      userId: 'me',
      q: `in:inbox ${fromFilter}subject:Re: newer_than:2d`,
      maxResults: 20,
    }).catch((e) => { log.err('inbox-list', e); return { data: { messages: [] } }; });
    const msgs = (res.data && res.data.messages) || [];
    for (const { id } of msgs) {
      if ((state.gmail || []).includes(id)) continue;
      let msgData;
      try { msgData = await gmail.users.messages.get({ userId: 'me', id, format: 'full' }); } catch (e) { log.err(`inbox-get:${id}`, e); continue; }
      const rawText = _extractGmailText(msgData.data.payload) || '';
      // Strip the quoted original below the reply
      const text = rawText.split(/\nOn .{5,80} wrote:\s*\n/)[0].trim();
      if (!text) continue;
      state.gmail = state.gmail || [];
      state.gmail.push(id);
      saveState(state); // claim before acting — a crash never double-processes
      log(`Reply (${id}): "${text.slice(0, 80)}" — processing`);
      const acted = await handleMessage(text, `mail:${id}`);
      log(`Reply: ${acted ? 'command executed' : 'no command found'}`);
      if (!acted && text.length > 1) {
        if (/^\s*(?:help|commands?|\?+)\b/i.test(text)) {
          await notify('Reply guide', 'To act on a post:\n  "1 yes" — approve + schedule\n  "1 no" — skip it\n  "1 change the hook to ..." — fix it\n  "approve all" — approve everything\n  "status" — see what\'s waiting\n  "note: ..." — leave feedback (never an action)');
        } else {
          // Unrecognized free text = FEEDBACK, never an action. Captured so
          // notes are never lost in a help-text loop.
          try { fs.appendFileSync(FEEDBACK_FILE, `[${ts()}] ${text}\n`); } catch (_) {}
          log(`FEEDBACK captured (mail:${id}): "${text.slice(0, 140)}"`);
        }
      }
    }
  } catch (e) {
    if (e.message && (e.message.includes('insufficient') || e.message.includes('scope'))) {
      log('Inbox poller: gmail.readonly scope missing from ADC token. Re-auth: gcloud auth application-default login --scopes=https://www.googleapis.com/auth/gmail.readonly,https://www.googleapis.com/auth/gmail.send,https://www.googleapis.com/auth/spreadsheets');
    } else {
      log.err('pollInbox', e);
    }
  }
}

// ---- single run ----
async function main() {
  log('================ APPROVAL HANDLER RUN START ================');
  if (!inActiveWindow()) { log('outside configured active window — exiting'); log('================ APPROVAL HANDLER RUN END ================\n'); return; }
  // Single-instance lock: a concurrent run (manual + scheduled) exits instead of racing
  const LOCK = path.join(LOG_DIR, 'approval.lock');
  try {
    if (fs.existsSync(LOCK) && Date.now() - fs.statSync(LOCK).mtimeMs < 10 * 60 * 1000) { log('another run holds the lock — exiting'); return; }
    fs.writeFileSync(LOCK, String(process.pid));
    process.on('exit', () => { try { fs.unlinkSync(LOCK); } catch (_) {} });
  } catch (_) {}
  const state = loadState();
  await pollInbox(state);
  saveState(state);
  log('================ APPROVAL HANDLER RUN END ================\n');
}

// ---- always-on daemon (long-poll watch) ----
// Stays resident under launchd/systemd KeepAlive so replies register within
// seconds instead of waiting for the next cron tick. Respects the same
// optional active window.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function watch() {
  log('================ APPROVAL DAEMON START (watch) ================');
  const LOCK = path.join(LOG_DIR, 'approval.lock');
  const state = loadState();
  let lastIdleLog = 0;
  for (;;) {
    try {
      if (!inActiveWindow()) {
        if (Date.now() - lastIdleLog > 30 * 60 * 1000) { log('idle (outside active window) — daemon resting'); lastIdleLog = Date.now(); }
        await sleep(60 * 1000);
        continue;
      }
      try { fs.writeFileSync(LOCK, String(process.pid)); } catch (_) {} // heartbeat so stray cron runs defer
      await pollInbox(state);
      saveState(state);
      await sleep(30 * 1000);
    } catch (e) {
      log.err('watch', e);
      await sleep(5000); // back off on transient errors, keep going
    }
  }
}

if (require.main === module) {
  if (process.argv.includes('--send-review')) {
    sendReview().then(() => process.exit(0)).catch((e) => { log.err('send-review', e); process.exit(0); });
  } else if (process.argv.includes('--watch')) {
    watch().catch((e) => { log.err('watch-fatal', e); process.exit(1); }); // KeepAlive restarts us
  } else {
    // default + --once: poll the inbox one time
    main().then(() => process.exit(0)).catch((e) => { log.err('main', e); process.exit(0); });
  }
}
module.exports = { handleMessage, todaysPending, parseDatePrefix, expandNL };
