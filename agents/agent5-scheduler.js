#!/usr/bin/env node
/* ============================================================================
 * AGENT 5 — SCHEDULER (the ONLY publisher in this repo)
 *
 * ⛔ HARD INVARIANT — the entire safety model, in three lines:
 *   1. This file is the ONLY code that calls the scheduler backend's publish
 *      endpoint (Blotato POST /v2/posts). Nothing else may ever post.
 *   2. The approval handler is the ONLY thing that invokes this agent in
 *      "approve" mode — and it only does so on YOUR explicit email reply.
 *   3. `--all-approved` (used by pipeline.js when config.approval.mode is
 *      "auto") is an explicit opt-in you set in config. Default is "approve".
 *
 * What it does: takes an approved content package (.md in output/pending/) +
 * optional media URL, reads the live Blotato calendar (FULLY paginated — see
 * note below), finds the next open slot per enabled platform, schedules via
 * Blotato, appends a row to your calendar sheet, and emails a confirmation.
 * On success the package is archived to output/approved/.
 *
 * Config it reads:
 *   platforms                        — only `true` entries are targeted
 *   scheduler.blotato_account_ids    — YOUR Blotato account ID per platform
 *   scheduler.slot_times_utc         — optional per-platform "HH:MM" overrides
 *   data.google_sheet_id             — calendar sheet (skipped if unset)
 *   brand.website                    — optional; outbound links get UTM params
 * Secrets (.env): SCHEDULER_API_KEY (Blotato), MAIL_SENDER.
 *
 * Run:
 *   node agents/agent5-scheduler.js --dry-run --content "topic keyword"
 *   node agents/agent5-scheduler.js --content "topic keyword" [--media URL]
 *   node agents/agent5-scheduler.js --all-approved     # auto mode only
 * All forms accept --config <path> (default config/config.json).
 *
 * Rule: if one platform errors, log and continue the rest. Never fail the batch.
 * ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const { OUT, ensureOutputDirs, envReader, configPath, loadConfig, makeLogger } = require('./common');

const log = makeLogger('scheduler');
const CFG = loadConfig();
const CONFIG_PATH = configPath();
const env = envReader();
const API_KEY = env('SCHEDULER_API_KEY');
ensureOutputDirs();

// ---- args ----
const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const ALL_APPROVED = argv.includes('--all-approved');
function arg(name) { const i = argv.indexOf(name); return i !== -1 ? argv[i + 1] : ''; }
const CONTENT = arg('--content');
const MEDIA = arg('--media');

// ---- accounts: enabled platforms ∩ configured account IDs ----
// Default slot times (UTC) per platform; override any of them with
// config.scheduler.slot_times_utc, e.g. { "linkedin": "14:30" }.
const DEFAULT_SLOTS = { linkedin: '16:00', instagram: '15:00', tiktok: '15:00', threads: '17:00', x: '18:00', facebook: '15:00', pinterest: '15:00' };
// Blotato's targetType naming where it differs from our config key.
const TARGET_TYPE = { x: 'twitter' };

function accounts() {
  const ids = (CFG.scheduler && CFG.scheduler.blotato_account_ids) || {};
  const slots = (CFG.scheduler && CFG.scheduler.slot_times_utc) || {};
  const enabled = Object.entries(CFG.platforms || {}).filter(([k, v]) => v === true && !k.startsWith('_')).map(([k]) => k);
  const out = [];
  for (const p of enabled) {
    const id = ids[p];
    if (!id || /^YOUR_/i.test(String(id))) { log(`  ⚠️  platform "${p}" is enabled but has no account ID in config.scheduler.blotato_account_ids — skipping`); continue; }
    out.push({ platform: p, id: String(id), slot: slots[p] || DEFAULT_SLOTS[p] || '15:00' });
  }
  return out;
}

// ---- find approved .md in output/pending/ ----
function findPackage(needle) {
  const files = fs.existsSync(OUT.pending) ? fs.readdirSync(OUT.pending).filter((f) => f.endsWith('.md') && !f.startsWith('.')) : [];
  const n = (needle || '').toLowerCase();
  let hit = files.find((f) => f.toLowerCase().includes(n.replace(/\s+/g, '-')));
  if (!hit) hit = files.find((f) => { try { return fs.readFileSync(path.join(OUT.pending, f), 'utf8').toLowerCase().includes(n); } catch (_) { return false; } });
  if (!hit && files.length) hit = files.sort().slice(-1)[0]; // most recent fallback
  return hit ? path.join(OUT.pending, hit) : null;
}

// ---- extract platform copy from a package ----
// Looks for a platform-specific "### <platform> caption" section, then a
// generic "### caption" section, then falls back to the hook line.
function extractCopy(md, platform) {
  const secRe = new RegExp(`###\\s*${platform}[^\\n]*caption[^\\n]*\\n([\\s\\S]*?)(?=\\n###|\\n## |$)`, 'i');
  const sec = md.match(secRe) || md.match(/###\s*caption[^\n]*\n([\s\S]*?)(?=\n###|\n## |$)/i);
  const hookM = md.match(/\*\*Hook[^:]*:\*\*\s*(.+)/) || md.match(/hook[:*"\s]+(.+)/i);
  const hashM = md.match(/\*\*Hashtags:\*\*\s*(.+)/i);
  const hashtags = hashM
    ? hashM[1].trim().split(/\s+/).slice(0, 5).map((h) => (h.startsWith('#') ? h : '#' + h)).join(' ')
    : '';
  // Strip inline #tags from the caption body — Instagram counts ALL hashtags
  // in the post (body + appended block) toward its limit; leaving inline tags
  // in causes a 422 when the appended block pushes it over.
  const rawCaption = (sec ? sec[1] : hookM ? hookM[1] : '').trim().replace(/#\w+/g, '').replace(/  +/g, ' ').trim();
  const caption = (rawCaption + (hashtags ? `\n\n${hashtags}` : '')).slice(0, 2000);
  return { hook: hookM ? hookM[1].trim() : '(no hook)', caption };
}

// ---- UTM attribution ----
// Every outbound link to YOUR site (config.brand.website) gets
// utm_source=agent&utm_medium=<platform>&utm_campaign=<experiment-or-engine>
// so analytics can attribute traffic per platform. Links that already carry
// utm_ params are left untouched. No website configured → no-op.
function utmify(text, platform) {
  const site = (CFG.brand && CFG.brand.website) || '';
  if (!text || !site) return text;
  const domain = site.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  const expM = text.match(/exp-\d{8}-[a-z0-9-]+/i);
  const campaign = expM ? expM[0].toLowerCase() : 'engine';
  const params = `utm_source=agent&utm_medium=${encodeURIComponent(platform || 'social')}&utm_campaign=${encodeURIComponent(campaign)}`;
  const re = new RegExp(`(https?:\\/\\/)?(www\\.)?${domain.replace(/\./g, '\\.')}(\\/[\\w\\-/]*)?(\\?[\\w=&%.\\-]*)?`, 'gi');
  return text.replace(re, (m, scheme, www, pth, qs) => {
    if (qs && /utm_/i.test(qs)) return m; // already attributed
    const base = (scheme || '') + (www || '') + domain + (pth || '');
    return base + (qs ? qs + '&' : '?') + params;
  });
}

// ---- fetch with retry (transient 5xx / network blips) ----
async function fetchRetry(url, opts, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, opts);
      if (res.status >= 500 && i < tries - 1) { lastErr = new Error(`HTTP ${res.status}`); }
      else return res;
    } catch (e) { lastErr = e; }
    await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
  }
  throw lastErr;
}

// ---- Blotato live read — FULLY paginated ----
// Picking a slot against page 1 only silently double-books everything past the
// first 50 scheduled posts. Always walk every page before planning.
const BLOTATO_CAP = 200; // Blotato rejects new posts once ~200 are scheduled
async function readBlotatoSchedule() {
  if (!API_KEY) { log('Scheduler: no SCHEDULER_API_KEY in .env — cannot read live calendar; planning against canonical times only.'); return null; }
  try {
    const all = [];
    for (let offset = 0; offset < 1000; offset += 50) {
      const res = await fetchRetry(`https://backend.blotato.com/v2/schedules?limit=50&offset=${offset}`, { headers: { 'blotato-api-key': API_KEY } });
      if (!res.ok) throw new Error(`Blotato HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
      const j = await res.json();
      const page = j.items || j.data || [];
      all.push(...page);
      if (page.length < 50) break;
    }
    log(`Blotato: read ${all.length} existing scheduled posts (all pages)`);
    return all;
  } catch (e) { log.err('blotato:read', e); return null; }
}

// ---- next open slot for an account ----
function nextSlot(existing, acct, baseDate) {
  for (let dayOffset = 1; dayOffset <= 14; dayOffset++) { // start tomorrow — avoids same-day past times
    const d = new Date(baseDate.getTime() + dayOffset * 86400000);
    const dateStr = d.toISOString().slice(0, 10);
    const iso = `${dateStr}T${acct.slot}:00Z`;
    const collision = (existing || []).some((p) => {
      const acctId = p.accountId || p.account_id || (p.target && p.target.accountId);
      const when = p.scheduledTime || p.scheduled_time || p.publishAt;
      if (String(acctId) !== String(acct.id) || !when) return false;
      const dt = new Date(when);
      if (dt.toISOString().slice(0, 10) !== dateStr) return false;
      return Math.abs(dt - new Date(iso)) < 2 * 3600 * 1000; // 2h same-account gap
    });
    if (!collision) return { platform: acct.platform, accountId: acct.id, dateUTC: dateStr, timeUTC: acct.slot, iso };
  }
  return { platform: acct.platform, accountId: acct.id, dateUTC: 'NO-SLOT', timeUTC: '', iso: '' };
}

// ---- confirmation email ----
async function emailConfirm(subject, body) {
  if (DRY) { log('DRY-RUN: confirmation email NOT sent.'); return; }
  try {
    const { sendMail } = require('./mailer');
    await sendMail(subject, body, { config: CFG });
    log('Confirmation email sent.');
  } catch (e) { log.err('mail', e); }
}

// ---- calendar sheet row (optional — skipped if data.google_sheet_id unset) ----
async function writeCalendarRow(s, v, mdPath) {
  const sheetId = (CFG.data && CFG.data.google_sheet_id) || '';
  if (!sheetId || /^YOUR_/i.test(sheetId)) { log('  (no google_sheet_id configured — skipping calendar row)'); return; }
  try {
    const { google } = require('googleapis');
    const auth = new google.auth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
    const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });
    const row = [`${s.platform}-${s.accountId}-${s.dateUTC}`, s.dateUTC, s.timeUTC, s.platform, s.accountId,
      path.basename(mdPath), v.caption, MEDIA || '', 'Scheduled', s.blotatoId || ''];
    await sheets.spreadsheets.values.append({ spreadsheetId: sheetId, range: 'Content Calendar!A1', valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', requestBody: { values: [row] } });
    log(`  Content Calendar row added for ${s.platform}`);
  } catch (e) { log.err(`sheet:${s.platform}`, e); }
}

// ---- schedule one package across all enabled platforms ----
async function scheduleOne(mdPath, existing) {
  const md = fs.readFileSync(mdPath, 'utf8');
  const base = new Date();
  const accts = accounts();
  if (!accts.length) { log('No platforms with account IDs configured — nothing to schedule. Check config.platforms + config.scheduler.blotato_account_ids.'); return { plan: [], okCount: 0 }; }

  // Blotato caps total scheduled posts — check BEFORE trying to create more,
  // so the failure is a clear message instead of N cryptic API errors.
  if (existing && existing.length >= BLOTATO_CAP) {
    log(`  ❌ Blotato calendar is at its ~${BLOTATO_CAP}-post cap (${existing.length} scheduled). Free slots (or wait for posts to publish) before scheduling more.`);
    await emailConfirm('❌ Scheduling blocked — calendar at capacity', `Blotato has ${existing.length} posts scheduled (cap ~${BLOTATO_CAP}). "${path.basename(mdPath)}" was NOT scheduled.`);
    return { plan: [], okCount: 0 };
  }

  // Host local media on the scheduler CDN so every platform sees a public URL.
  let mediaUrl = MEDIA;
  if (mediaUrl && fs.existsSync(mediaUrl)) {
    try {
      const { publish } = require('./media-publisher');
      const r = await publish(mediaUrl);
      if (r && r.url) { log(`Media hosted on CDN → ${r.url}`); mediaUrl = r.url; }
      else log(`Media publish FAILED — keeping local path "${MEDIA}" (will likely fail at the API)`);
    } catch (e) { log(`Media publish error: ${e.message}`); }
  }

  const plan = accts.map((a) => nextSlot(existing, a, base));
  const v = extractCopy(md, ''); // package-level copy; per-platform section wins below
  log('PLANNED BOOKINGS:');
  plan.forEach((s) => log(`  • ${s.platform} (account ${s.accountId}) — ${s.dateUTC} ${s.timeUTC} UTC`));

  if (DRY) {
    log('DRY-RUN: no posts created, no calendar rows written, no email sent.');
    return { plan, okCount: 0 };
  }

  for (const s of plan) {
    try {
      if (!API_KEY) throw new Error('no SCHEDULER_API_KEY in .env');
      if (s.dateUTC === 'NO-SLOT') throw new Error('no open slot in 14 days');
      const copy = extractCopy(md, s.platform);
      if (!mediaUrl && ['instagram', 'tiktok', 'pinterest'].includes(s.platform)) {
        // Skip (don't throw) so the rest of the batch continues; log loudly so
        // the report surfaces it instead of silently dropping the post.
        const msg = `SKIPPED ${s.platform}: requires media (text-only not supported). Pass --media <url> to include.`;
        log(`  ⚠️  ${msg}`);
        s.error = msg;
        continue;
      }
      // Threads and X support at most ONE image or video — never a carousel.
      if (['threads', 'x'].includes(s.platform) && mediaUrl && /carousel|multi|slide-[2-9]/i.test(mediaUrl)) {
        throw new Error(`${s.platform} does not support carousels — attach one image or run text-only`);
      }
      const target = { targetType: TARGET_TYPE[s.platform] || s.platform };
      if (s.platform === 'tiktok') Object.assign(target, { privacyLevel: 'PUBLIC_TO_EVERYONE', disabledComments: false, disabledDuet: false, disabledStitch: false, isBrandedContent: false, isYourBrand: false, isAiGenerated: true });
      const res = await fetchRetry('https://backend.blotato.com/v2/posts', {
        method: 'POST', headers: { 'blotato-api-key': API_KEY, 'content-type': 'application/json' },
        body: JSON.stringify({
          post: { accountId: s.accountId, target, content: { text: utmify(copy.caption, s.platform), platform: TARGET_TYPE[s.platform] || s.platform, mediaUrls: mediaUrl ? [mediaUrl] : [] } },
          scheduledTime: s.iso,
        }),
      });
      if (!res.ok) throw new Error(`Blotato HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
      const j = await res.json();
      s.blotatoId = j.id || (j.post && j.post.id) || j.scheduleId || '(created)';
      log(`  Scheduled ${s.platform}: ${s.blotatoId}`);
      await writeCalendarRow(s, copy, mdPath);
    } catch (e) { s.error = e.message; log.err(`schedule:${s.platform}`, e); }
  }

  // HONEST confirmation — built AFTER the attempts, reflects real outcomes.
  const okCount = plan.filter((s) => s.blotatoId).length;
  const name = path.basename(mdPath).replace(/\.md$/, '');
  const subject = okCount === plan.length ? `✅ Scheduled — ${name}`
    : okCount > 0 ? `⚠️ Partially scheduled (${okCount}/${plan.length}) — ${name}`
      : `❌ Scheduling FAILED — ${name}`;
  let body = `Package: ${name}\nMedia: ${MEDIA || '(text-only)'}\n\nResults:\n`;
  plan.forEach((s) => {
    body += s.blotatoId
      ? `  ✅ ${s.platform} — ${s.dateUTC} ${s.timeUTC} UTC — ${s.blotatoId}\n`
      : `  ❌ ${s.platform} — FAILED: ${s.error || 'unknown'}\n`;
  });
  await emailConfirm(subject, body);

  // AUTO-ARCHIVE: once a package is scheduled to at least one platform it's
  // done — move it to output/approved/ so pending never needs manual clearing.
  // Never archive on total failure, so a failed package stays visible to retry.
  if (okCount > 0 && mdPath.startsWith(OUT.pending)) {
    try {
      const dest = path.join(OUT.approved, path.basename(mdPath));
      fs.renameSync(mdPath, dest);
      log(`  📦 archived package → output/approved/${path.basename(mdPath)} (${okCount}/${plan.length} scheduled)`);
    } catch (e) { log.err('archive', e); }
  }
  return { plan, okCount, hook: v.hook };
}

// ---- main ----
async function main() {
  log(`================ SCHEDULER RUN START ${DRY ? '(DRY-RUN)' : '(LIVE)'} ================`);
  log(`config=${CONFIG_PATH} content="${CONTENT}" media="${MEDIA || '(none)'}" all-approved=${ALL_APPROVED}`);

  const existing = await readBlotatoSchedule();

  if (ALL_APPROVED) {
    // Auto mode (pipeline.js) — schedules every pending package. Only reach
    // this path when config.approval.mode is "auto"; in "approve" mode the
    // pipeline routes through the approval handler instead.
    const mode = (CFG.approval && CFG.approval.mode) || 'approve';
    if (mode !== 'auto') { log('--all-approved requested but config.approval.mode is not "auto" — refusing (the approval handler is the only publisher trigger in approve mode).'); return; }
    const files = fs.existsSync(OUT.pending) ? fs.readdirSync(OUT.pending).filter((f) => f.endsWith('.md') && !f.startsWith('.')).sort() : [];
    if (!files.length) { log('No pending packages — nothing to schedule.'); return; }
    for (const f of files) await scheduleOne(path.join(OUT.pending, f), existing);
  } else {
    const mdPath = findPackage(CONTENT);
    if (!mdPath) { log('No matching package found in output/pending/ — aborting (logged).'); return; }
    log(`Package: ${path.basename(mdPath)}`);
    await scheduleOne(mdPath, existing);
  }

  log(`================ SCHEDULER RUN END ${DRY ? '(DRY-RUN)' : '(LIVE)'} ================\n`);
}

if (require.main === module) main().then(() => process.exit(0)).catch((e) => { log.err('main', e); process.exit(0); });
module.exports = { nextSlot, extractCopy, utmify, accounts };
