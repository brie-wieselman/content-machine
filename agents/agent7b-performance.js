#!/usr/bin/env node
/* ============================================================================
 * agent7b-performance.js — own-account analytics collector.
 *
 * Closes the analytics loop: most scheduler APIs expose no analytics, so the
 * weekly analyst (agent7) would otherwise fly blind. This agent reads YOUR OWN
 * accounts' recent post performance via RapidAPI scrapers (the same providers
 * the trend scout uses for competitors) and appends rows to the Performance
 * Log tab of your Google Sheet — giving the analyst real numbers for
 * "double down / kill" calls.
 *
 * Which accounts: comes entirely from config —
 *   config.performance.instagram_handles   e.g. ["yourhandle"]
 *   config.performance.linkedin_slug       e.g. "your-linkedin-slug"
 * Platforms are only collected if enabled in config.platforms.
 *
 * VELOCITY-AWARE DEDUP (worth keeping): logs/performance-seen.json remembers
 * each post URL's last captured engagement. A post is re-written to the sheet
 * only if engagement grew >25% since last capture — so you track velocity
 * without duplicating static rows on every run.
 *
 * Performance Log columns:
 *   Date | Platform | Account | Post Title/Hook | URL | Likes | Comments |
 *   Shares/Reposts | Views | Engagement Score | Captured At
 *
 * Run: node agents/agent7b-performance.js --once [--config <path>]
 * Wired into: pipeline runs (before the reporter) + the weekly analyst.
 * ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const { LOG_DIR, loadConfig, envReader, ts, makeLogger } = require('./common');
const log = makeLogger('performance');

const SEEN_FILE = path.join(LOG_DIR, 'performance-seen.json');

const CFG = loadConfig();
const env = envReader();
const RAPIDAPI_KEY = env('RAPIDAPI_KEY');
const SHEET_ID = (CFG.data && CFG.data.google_sheet_id) || env('GOOGLE_SHEETS_ID');

const platformOn = (p) => !!(CFG.platforms && CFG.platforms[p]);
const IG_HANDLES = (platformOn('instagram') && CFG.performance && Array.isArray(CFG.performance.instagram_handles))
  ? CFG.performance.instagram_handles.map((h) => String(h).replace(/^@/, '')) : [];
const LINKEDIN_SLUG = (platformOn('linkedin') && CFG.performance && CFG.performance.linkedin_slug) || '';

async function getJSON(url, opts, retries = 2) {
  for (let i = 0; ; i++) {
    const r = await fetch(url, opts);
    if (r.status === 429 && i < retries) { await new Promise((x) => setTimeout(x, 25000)); continue; }
    if (!r.ok) throw new Error(`HTTP ${r.status} ${url.split('?')[0]}`);
    return r.json();
  }
}

function seen() { try { return JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8')); } catch (_) { return {}; } }
function saveSeen(s) { fs.writeFileSync(SEEN_FILE, JSON.stringify(s, null, 1)); }

// ---- Instagram own accounts -------------------------------------------------
async function collectInstagram() {
  if (!IG_HANDLES.length) { log('IG: no handles configured (config.performance.instagram_handles) — skipping'); return []; }
  if (!RAPIDAPI_KEY) { log('IG: no RAPIDAPI_KEY — skipping'); return []; }
  // Override the provider host with IG_RAPIDAPI_HOST in .env to swap scrapers.
  const host = (env('IG_RAPIDAPI_HOST') || 'flashapi1.p.rapidapi.com').trim();
  const hdrs = { 'X-RapidAPI-Key': RAPIDAPI_KEY, 'X-RapidAPI-Host': host };
  const rows = [];
  for (const handle of IG_HANDLES) {
    try {
      // These providers rate-limit aggressively — space the calls out.
      await new Promise((r) => setTimeout(r, 4000));
      const data = await getJSON(`https://${host}/ig/posts_username/?user=${encodeURIComponent(handle)}&count=15`, { headers: hdrs });
      const items = (data && data.items) || [];
      if (!items.length) { log(`IG @${handle}: no posts returned (${(data && data.message) || 'empty items'})`); continue; }
      for (const it of items) {
        const p = it.media || it;
        const likes = p.like_count || 0;
        const comments = p.comment_count || 0;
        const views = p.play_count || p.view_count || '';
        const eng = likes + comments * 5;
        const url = p.code ? `https://www.instagram.com/p/${p.code}/` : `${handle}-${p.pk || p.id || ''}`;
        const date = p.taken_at ? new Date(p.taken_at * 1000).toISOString().slice(0, 10) : ts().slice(0, 10);
        rows.push({
          key: url,
          row: [date, 'Instagram', `@${handle}`,
            (((p.caption && p.caption.text) || '').split('\n')[0] || '').slice(0, 120),
            url, likes, comments, '', views, eng, ts()],
          eng,
        });
      }
      log(`IG @${handle}: ${items.length} posts collected`);
    } catch (e) { log(`IG @${handle}: ${e.message}`); }
  }
  return rows;
}

// ---- LinkedIn own profile ---------------------------------------------------
async function collectLinkedIn() {
  if (!LINKEDIN_SLUG) { log('LinkedIn: no slug configured (config.performance.linkedin_slug) — skipping'); return []; }
  if (!RAPIDAPI_KEY) return [];
  const host = (env('LINKEDIN_RAPIDAPI_HOST') || '').trim();
  if (!host) { log('LinkedIn: no LINKEDIN_RAPIDAPI_HOST in .env — skipping'); return []; }
  try {
    const data = await getJSON(`https://${host}/get-profile-posts?linkedin_url=${encodeURIComponent('https://www.linkedin.com/in/' + LINKEDIN_SLUG)}&type=posts`, {
      headers: { 'X-RapidAPI-Key': RAPIDAPI_KEY, 'X-RapidAPI-Host': host },
    });
    if (data && data.success === false) { log(`LinkedIn self: provider says "${(data.message || '').slice(0, 80)}"`); return []; }
    const posts = (data && (data.data || data.posts)) || [];
    if (!Array.isArray(posts) || !posts.length) { log(`LinkedIn self: no posts returned — verify slug "${LINKEDIN_SLUG}"`); return []; }
    const rows = posts.map((p) => {
      const likes = p.num_reactions || p.totalReactionCount || 0;
      const comments = p.num_comments || p.commentsCount || 0;
      const reposts = p.num_reposts || p.repostsCount || 0;
      const eng = likes + comments * 5 + reposts * 3;
      return {
        key: p.post_url || p.url || `li-${(p.urn || p.id || '').toString().slice(-12)}`,
        row: [(p.posted_date || p.postedAt || ts()).toString().slice(0, 10), 'LinkedIn', LINKEDIN_SLUG,
          ((p.text || '').split('\n')[0] || '').slice(0, 120),
          p.post_url || p.url || '', likes, comments, reposts, '', eng, ts()],
        eng,
      };
    });
    log(`LinkedIn self: ${rows.length} posts collected`);
    return rows;
  } catch (e) { log(`LinkedIn self: ${e.message}`); return []; }
}

// ---- Sheets append ----------------------------------------------------------
async function appendPerformance(rows) {
  if (!rows.length) { log('Performance Log: nothing new to append'); return; }
  if (!SHEET_ID) { log('Performance Log: no config.data.google_sheet_id — skipping sheet write'); return; }
  try {
    const { google } = require('googleapis');
    const auth = new google.auth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
    const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID, range: 'Performance Log!A1', valueInputOption: 'USER_ENTERED',
      requestBody: { values: rows },
    });
    log(`Performance Log: appended ${rows.length} row(s)`);
  } catch (e) {
    const fb = path.join(LOG_DIR, `pending-performance-${ts().slice(0, 10)}.json`);
    fs.writeFileSync(fb, JSON.stringify(rows, null, 1));
    log(`Performance Log: sheets write FAILED (${e.message.slice(0, 120)}) — saved ${path.basename(fb)}`);
  }
}

async function run() {
  log('================ PERFORMANCE COLLECTOR START ================');
  const all = [...await collectInstagram(), ...await collectLinkedIn()];
  const s = seen();
  // write new posts, or re-capture when engagement grew >25% (velocity tracking)
  const fresh = all.filter((x) => !s[x.key] || (x.eng > 0 && x.eng > (s[x.key] || 0) * 1.25));
  fresh.forEach((x) => { s[x.key] = x.eng; });
  saveSeen(s);
  await appendPerformance(fresh.map((x) => x.row));
  log(`SUMMARY: collected=${all.length} new/updated=${fresh.length}`);
  log('================ PERFORMANCE COLLECTOR END ================\n');
  return fresh.length;
}

module.exports = { run };
if (require.main === module) run().then(() => process.exit(0)).catch((e) => { log(`FATAL: ${e.message}`); process.exit(0); });
