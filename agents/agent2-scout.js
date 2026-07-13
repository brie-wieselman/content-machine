#!/usr/bin/env node
'use strict';
/* ============================================================================
 * AGENT 2 — TREND SCOUT (optional stage)
 *
 * Mines your niche for outlier content and audience tensions:
 *   1. YouTube  — outlier videos on the channels YOU list in config
 *   2. Reddit   — top weekly posts in the subreddits YOU list in config
 *   3. X/Twitter + Instagram + LinkedIn — via YOUR RapidAPI subscriptions
 *   4. Writes outliers -> "Daily Outlier" tab, tensions -> "Social Pulse" tab
 *      of your Google Sheet (see docs/sheet-template.md), and saves a
 *      morning digest to output/scout/.
 *
 * This stage is OPTIONAL. It only runs when config.topics.mode === "scraper"
 * and config.topics.scraper.enabled === true. In "manual" topic mode the
 * pipeline skips it entirely and no paid APIs are needed.
 *
 * Requires (in .env at the repo root):
 *   YOUTUBE_DATA_API_KEY  — for the YouTube miner (free tier is plenty)
 *   RAPIDAPI_KEY          — for the X/IG/LinkedIn miners (your own subscriptions)
 * The Reddit miner needs no key. Each miner that lacks its key is skipped
 * with a log line; if NO keys are present the run exits with instructions.
 *
 *   node agents/agent2-scout.js --once [--config config/config.json]
 *
 * Design rule: if ANY API call fails, log it and continue. Nothing is allowed
 * to crash the whole run. Anything that can't be written to Sheets is saved
 * to output/scout/ so no signal is lost.
 * ========================================================================== */

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Paths + CLI
// ---------------------------------------------------------------------------
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'output', 'scout');
const LOG_FILE = path.join(OUT_DIR, 'scout-log.txt');
fs.mkdirSync(OUT_DIR, { recursive: true });

function cliArg(flag, dflt) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const CONFIG_PATH = path.resolve(ROOT, cliArg('--config', 'config/config.json'));

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
function ts() { return new Date().toISOString(); }
function ymd() { return new Date().toISOString().slice(0, 10); }
function log(msg) {
  const line = `[${ts()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (_) {}
}
function logErr(scope, e) { log(`ERROR [${scope}]: ${e && e.message ? e.message : e}`); }

// Wrap any async unit of work so a failure logs + returns a fallback,
// never throwing up the stack.
async function safe(scope, fn, fallback) {
  try { return await fn(); }
  catch (e) { logErr(scope, e); return fallback; }
}

// ---------------------------------------------------------------------------
// Env — repo-root .env, merged under process.env (process.env wins)
// ---------------------------------------------------------------------------
function loadEnv() {
  const envPath = path.join(ROOT, '.env');
  const env = {};
  if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split(/\r?\n/).forEach((ln) => {
      const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) env[m[1]] = m[2].trim();
    });
  }
  return env;
}
const ENV = loadEnv();
function envVal(...keys) {
  for (const k of keys) {
    const v = (process.env[k] || ENV[k] || '').trim();
    if (v && !/^your-/.test(v)) return v; // ignore untouched .env.example placeholders
  }
  return '';
}

const YOUTUBE_KEY = envVal('YOUTUBE_DATA_API_KEY');
const RAPIDAPI_KEY = envVal('RAPIDAPI_KEY');
const MAIL_SENDER = envVal('MAIL_SENDER');

// ---------------------------------------------------------------------------
// Config — everything brand/niche-specific comes from config, never from code
// ---------------------------------------------------------------------------
function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`Missing config at ${CONFIG_PATH} — copy config/config.example.json to config/config.json and fill it in.`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}
const CFG = loadConfig();
const SCRAPER = (CFG.topics && CFG.topics.scraper) || {};
const SHEET_ID = (CFG.data && CFG.data.google_sheet_id) || '';
const NICHE_KEYWORDS = (CFG.topics && CFG.topics.niche_keywords) || [];

// Channels: entries may be "CHANNEL_ID" strings or { name, id, lane } objects.
// e.g. { "name": "Example Gardening Channel", "id": "<channel id>", "lane": "urban gardening" }
const YT_CHANNELS = (SCRAPER.youtube_channels_to_watch || []).map((c) =>
  typeof c === 'string' ? { name: c, id: c, lane: 'general' } : { lane: 'general', ...c });
const SUBREDDITS = SCRAPER.reddit_subs_to_watch || [];
// Optional extra source lists (add them to your scraper block if you use them):
const IG_ACCOUNTS = SCRAPER.instagram_accounts_to_watch || [];
const SEARCH_TERMS = SCRAPER.search_terms || NICHE_KEYWORDS;

const OUTLIER_STRONG = 200;   // >200% of the source's own average = strong outlier
const OUTLIER_VIRAL = 500;    // >500% = viral
const SMALL_CHANNEL = 50000;  // prioritize creators under 50K subs (replicable wins)

// ---------------------------------------------------------------------------
// Hook-structure heuristic classifier (structure only — never copy phrasing)
// ---------------------------------------------------------------------------
function classifyHook(text) {
  const t = (text || '').toLowerCase();
  if (/\b(myth|wrong|lie|don'?t believe|actually|truth about|debunk|stop)\b/.test(t)) return 'myth-bust';
  if (/\b(i (was|felt|thought|never|finally)|my (story|journey)|confession|honestly|i'?m)\b/.test(t)) return 'confession';
  if (/\b(how|why|because|mechanism|works|happens|cause|reason|science)\b/.test(t)) return 'mechanism';
  if (/\b(expert|years|research|study|proven|tested)\b/.test(t)) return 'authority';
  return 'pattern-interrupt';
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------
async function getJSON(url, opts = {}) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${url.split('?')[0]} ${body.slice(0, 160)}`);
  }
  return res.json();
}

// ===========================================================================
// YOUTUBE MINER
// ===========================================================================
// NOTE ON OUTLIER SCORING:
// The public YouTube Data API exposes a video's *cumulative* viewCount, not a
// per-day history (that needs the owner-only Analytics API). So we approximate:
//   - "views in 5 days" ~ current viewCount of videos published <=5 days ago
//   - channel "avg views" ~ average viewCount of the channel's recent uploads
//     as a typical-performance baseline.
// Score = (candidate views / channel avg views) * 100. Labeled as approx.
// Lookup is always by channel ID, never by name-search — name-search grabs
// imposter channels.
async function ytChannelById(channelId) {
  const chUrl =
    `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics,contentDetails` +
    `&id=${channelId}&key=${YOUTUBE_KEY}`;
  const c = await getJSON(chUrl);
  if (!c.items || !c.items.length) throw new Error(`channel id not found: ${channelId}`);
  const ch = c.items[0];
  return {
    name: ch.snippet.title,
    channelId,
    subs: parseInt(ch.statistics.subscriberCount || '0', 10),
    uploadsPlaylist: ch.contentDetails.relatedPlaylists.uploads,
  };
}

async function ytRecentVideos(uploadsPlaylist, max = 15) {
  const plUrl =
    `https://www.googleapis.com/youtube/v3/playlistItems?part=contentDetails&maxResults=${max}` +
    `&playlistId=${uploadsPlaylist}&key=${YOUTUBE_KEY}`;
  const pl = await getJSON(plUrl);
  const ids = (pl.items || []).map((i) => i.contentDetails.videoId).filter(Boolean);
  if (!ids.length) return [];
  const vUrl =
    `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&id=${ids.join(',')}&key=${YOUTUBE_KEY}`;
  const v = await getJSON(vUrl);
  return (v.items || []).map((it) => ({
    videoId: it.id,
    title: it.snippet.title,
    description: it.snippet.description || '',
    publishedAt: it.snippet.publishedAt,
    views: parseInt(it.statistics.viewCount || '0', 10),
    url: `https://www.youtube.com/watch?v=${it.id}`,
  }));
}

async function mineYouTube() {
  const results = [];
  if (!YOUTUBE_KEY) { log('YouTube: no YOUTUBE_DATA_API_KEY in .env — skipping'); return results; }
  if (!YT_CHANNELS.length) { log('YouTube: no youtube_channels_to_watch in config — skipping'); return results; }
  const now = Date.now();
  const fiveDays = 5 * 24 * 3600 * 1000;

  for (const chCfg of YT_CHANNELS) {
    const name = chCfg.name;
    const ch = await safe(`yt:resolve:${name}`, () => ytChannelById(chCfg.id), null);
    if (!ch) continue;
    const vids = await safe(`yt:videos:${name}`, () => ytRecentVideos(ch.uploadsPlaylist), []);
    if (!vids.length) continue;

    // baseline = avg views across recent uploads (typical performance)
    const avg = Math.max(1, Math.round(vids.reduce((s, v) => s + v.views, 0) / vids.length));
    const recent = vids.filter((v) => now - new Date(v.publishedAt).getTime() <= fiveDays);

    for (const v of recent) {
      const score = Math.round((v.views / avg) * 100);
      if (score <= OUTLIER_STRONG) continue; // only surface strong+ outliers
      const hookProxy = (v.description.split('\n').find((l) => l.trim().length > 0) || v.title).slice(0, 200);
      results.push({
        date: ymd(),
        platform: 'YouTube',
        creator: ch.name,
        subs: ch.subs,
        title: v.title,
        url: v.url,
        views: v.views,
        score,
        tier: score > OUTLIER_VIRAL ? 'VIRAL' : 'STRONG',
        smallChannel: ch.subs < SMALL_CHANNEL,
        hookType: classifyHook(v.title),
        hookText: hookProxy, // transcript unavailable via public Data API; title/description proxy
        lane: chCfg.lane,
        publishedAt: v.publishedAt,
      });
    }
    log(`YouTube ${name}: subs=${ch.subs} recent5d=${recent.length} avgViews=${avg}`);
  }
  // Prioritize small channels (their wins are replicable), then score
  results.sort((a, b) => (b.smallChannel - a.smallChannel) || (b.score - a.score));
  return results;
}

// ===========================================================================
// REDDIT MINER (no API key needed)
// ===========================================================================
function coreTension(title) {
  // Heuristic one-liner (kept cheap — no model call in this agent).
  const t = (title || '').toLowerCase();
  if (/\?$/.test((title || '').trim()) || /\bhow\b|\bwhat\b|\bwhy\b|\bshould i\b|\banyone\b/.test(t))
    return `Seeking answers/validation: "${(title || '').slice(0, 90)}"`;
  if (/\b(mistake|failed|ruined|wasted|regret|warning)\b/.test(t))
    return `Cautionary tale, wants to warn others: "${(title || '').slice(0, 90)}"`;
  if (/\b(finally|success|before and after|proud|worked)\b/.test(t))
    return `Sharing a win, wants recognition: "${(title || '').slice(0, 90)}"`;
  return `Frustration/discussion: "${(title || '').slice(0, 90)}"`;
}
function contentAngle(source, title) {
  return `Address "${(title || '').slice(0, 60)}" through a ${classifyHook(title)} hook — explain the underlying mechanism, give a concrete next step, invite a reply.`;
}

async function redditGet(urlPath, UA) {
  // Try www then old.reddit (old. is friendlier to scripted JSON pulls)
  const hosts = ['https://www.reddit.com', 'https://old.reddit.com'];
  let lastErr;
  for (const h of hosts) {
    try { return await getJSON(h + urlPath, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } }); }
    catch (e) { lastErr = e; }
  }
  throw lastErr;
}

// Save raw reference material for outliers so downstream agents can model
// hook STRUCTURE and visual treatment (output/scout/references/<platform>/).
// Structure only — the writer must never lift phrasing from references.
const REF_DIR = path.join(OUT_DIR, 'references');
function saveRef(platform, name, content) {
  try {
    const d = path.join(REF_DIR, platform);
    fs.mkdirSync(d, { recursive: true });
    const f = path.join(d, `${ymd()}-${name.replace(/[^a-z0-9_-]+/gi, '-').slice(0, 80)}.txt`);
    fs.writeFileSync(f, content);
    return f;
  } catch (e) { logErr(`saveRef:${platform}`, e); return null; }
}

async function mineReddit() {
  const out = [];
  if (!SUBREDDITS.length) { log('Reddit: no reddit_subs_to_watch in config — skipping'); return out; }
  // Realistic browser UA — Reddit 403s generic/script UAs from many IPs
  const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
  for (const sub of SUBREDDITS) {
    const data = await safe(`reddit:${sub}`, () =>
      redditGet(`/r/${sub}/top.json?t=week&limit=5`, UA), null);
    if (!data || !data.data) continue;
    for (const c of data.data.children.slice(0, 3)) {
      const p = c.data;
      let topComment = '';
      const cm = await safe(`reddit:comments:${p.id}`, () =>
        redditGet(`/r/${sub}/comments/${p.id}.json?limit=1&sort=top`, UA), null);
      if (cm && cm[1] && cm[1].data && cm[1].data.children[0]) {
        topComment = (cm[1].data.children[0].data.body || '').slice(0, 280);
      }
      out.push({
        date: ymd(),
        subreddit: `r/${sub}`,
        platform: 'Reddit',
        title: p.title,
        url: `https://www.reddit.com${p.permalink}`,
        upvotes: p.ups,
        topComment,
        coreTension: coreTension(p.title),
        contentAngle: contentAngle(sub, p.title),
        hookDraft: `${classifyHook(p.title)}: ${p.title.slice(0, 80)}`,
        refFile: p.ups > 300 ? saveRef('reddit', `${sub}-${p.id}`,
          `r/${sub} | ${p.ups} upvotes | ${p.title}\nURL: https://www.reddit.com${p.permalink}\n\n${(p.selftext || '').slice(0, 4000)}\n\nTOP COMMENT:\n${topComment}`) : null,
      });
    }
    log(`Reddit r/${sub}: pulled ${out.filter(o => o.subreddit === 'r/' + sub).length} posts`);
  }
  out.sort((a, b) => b.upvotes - a.upvotes);
  return out;
}

// ===========================================================================
// RAPIDAPI MINERS — X/Twitter + Instagram
// (Best-effort: each requires an active subscription to the relevant RapidAPI
// product on YOUR account. Failures are logged and skipped, never fatal.)
// ===========================================================================
async function mineTwitter() {
  const out = [];
  if (!RAPIDAPI_KEY) { log('Twitter: no RAPIDAPI_KEY in .env — skipping'); return out; }
  if (!SEARCH_TERMS.length) { log('Twitter: no search terms (niche_keywords) in config — skipping'); return out; }
  // Override with X_RAPIDAPI_HOST if you subscribe to a different provider.
  const host = (process.env.X_RAPIDAPI_HOST || 'twitter154.p.rapidapi.com').trim();
  for (const term of SEARCH_TERMS) {
    const data = await safe(`twitter:${term}`, () =>
      getJSON(`https://${host}/search/search?query=${encodeURIComponent(term)}&section=top&limit=5&language=en`, {
        headers: { 'X-RapidAPI-Key': RAPIDAPI_KEY, 'X-RapidAPI-Host': host },
      }), null);
    const items = data && (data.results || data.tweets || []);
    if (!items || !items.length) continue;
    for (const tw of items.slice(0, 3)) {
      const text = tw.text || tw.full_text || '';
      const eng = (tw.favorite_count || 0) + (tw.retweet_count || 0) + (tw.reply_count || 0);
      out.push({
        date: ymd(),
        platform: 'X/Twitter',
        subreddit: `search:${term}`,
        title: text.slice(0, 120),
        url: tw.tweet_id ? `https://twitter.com/i/web/status/${tw.tweet_id}` : '',
        upvotes: eng,
        topComment: '',
        coreTension: coreTension(text),
        contentAngle: contentAngle(term, text),
        hookDraft: `${classifyHook(text)}: ${text.slice(0, 80)}`,
        handle: tw.user && (tw.user.username || tw.user.screen_name),
        refFile: eng > 200 ? saveRef('twitter', `${(tw.user && (tw.user.username || tw.user.screen_name)) || 'unknown'}-${tw.tweet_id || ''}`,
          `@${(tw.user && (tw.user.username || tw.user.screen_name)) || '?'} | engagement ${eng} | followers ${(tw.user && tw.user.followers_count) || '?'}\n\n${text}`) : null,
      });
    }
    log(`Twitter "${term}": ${items.length} results`);
  }
  return out;
}

async function mineInstagram() {
  // Monitor the accounts you list (last posts), compute outlier vs the
  // account's own average, save cover refs for outliers.
  if (!RAPIDAPI_KEY) { log('Instagram: no RAPIDAPI_KEY in .env — skipping'); return []; }
  if (!IG_ACCOUNTS.length) { log('Instagram: no instagram_accounts_to_watch in config — skipping'); return []; }
  // Override with IG_RAPIDAPI_HOST to match whichever provider you subscribe
  // to; the item-shape normalization below may need adjusting per provider.
  const host = (process.env.IG_RAPIDAPI_HOST || 'flashapi1.p.rapidapi.com').trim();
  const hdrs = { 'X-RapidAPI-Key': RAPIDAPI_KEY, 'X-RapidAPI-Host': host };
  const out = [];
  for (const handle of IG_ACCOUNTS) {
    // Providers rate-limit aggressively — space the calls out
    await new Promise((r) => setTimeout(r, 4000));
    const data = await safe(`ig:${handle}`, () =>
      getJSON(`https://${host}/ig/posts_username/?user=${encodeURIComponent(handle)}&count=10`, { headers: hdrs }), null);
    const rawItems = (data && data.items) || [];
    if (!rawItems.length) { log(`Instagram @${handle}: no posts returned${data && data.message ? ` (${data.message})` : ''}`); continue; }
    // normalize the provider item shape to the fields used below
    const posts = rawItems.map((it) => {
      const m = it.media || it;
      const iv = (m.image_versions2 && m.image_versions2.candidates) || [];
      return {
        id: m.pk || m.id || '',
        shortcode: m.code || '',
        url: m.code ? `https://www.instagram.com/p/${m.code}/` : '',
        text: (m.caption && m.caption.text) || '',
        likes: m.like_count || 0,
        comments: m.comment_count || 0,
        views: m.play_count || m.view_count || '',
        isVideo: m.media_type === 2 || m.product_type === 'clips',
        sidecar: m.media_type === 8 || (m.carousel_media_count || 0) > 1,
        displayUrl: (iv[0] && iv[0].url) || '',
      };
    });
    const eng = (p) => (p.likes || 0) + (p.comments || 0) * 5;
    const avg = posts.reduce((s, p) => s + eng(p), 0) / posts.length || 1;
    for (const p of posts.slice(0, 5)) {
      const caption = p.text || '';
      const score = Math.round((eng(p) / avg) * 100);
      const fmt = p.isVideo ? 'reel' : (p.sidecar ? 'carousel' : 'static');
      const item = {
        date: ymd(),
        platform: 'Instagram',
        subreddit: `@${handle}`,
        title: caption.split('\n')[0].slice(0, 120),
        url: p.url || '',
        upvotes: eng(p),
        topComment: `format:${fmt} | views:${p.views || ''}`,
        coreTension: coreTension(caption),
        contentAngle: contentAngle(handle, caption),
        hookDraft: `${classifyHook(caption)}: ${caption.split('\n')[0].slice(0, 80)}`,
        score,
      };
      if (score > OUTLIER_STRONG) {
        item.refFile = saveRef('ig', `${handle}-${p.id || p.shortcode || ''}`,
          `@${handle} | ${fmt} | engagement ${eng(p)} (${score} vs avg)\nURL: ${item.url}\nCover: ${p.displayUrl || ''}\n\nCAPTION:\n${caption.slice(0, 3000)}`);
        // download cover image for visual-structure modeling downstream
        if (p.displayUrl) await safe(`ig:cover:${handle}`, async () => {
          const d = path.join(REF_DIR, 'ig');
          fs.mkdirSync(d, { recursive: true });
          const buf = Buffer.from(await (await fetch(p.displayUrl)).arrayBuffer());
          fs.writeFileSync(path.join(d, `${ymd()}-${handle}-${(p.id || p.shortcode || 'post')}.jpg`), buf);
        }, null);
      }
      out.push(item);
    }
    log(`Instagram @${handle}: ${posts.length} posts mined (avg eng ${Math.round(avg)})`);
  }
  return out;
}

// ===========================================================================
// LINKEDIN MINER — watch-list of creators you admire in your lane(s)
// Host-agnostic: reads config/linkedin-watchlist.json (host + profiles), so a
// dead scraper product (it happens) is a one-line config swap, not a code
// change. Outlier scoring mirrors mineInstagram: engagement vs the author's
// own average; score >200 saves a full reference file (hook structure, flow,
// visual notes) for the writer to pattern-match — structure only, never text.
// ===========================================================================
function linkedinWatchlist() {
  const f = path.join(path.dirname(CONFIG_PATH), 'linkedin-watchlist.json');
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch (_) { return { host: '', profiles: [] }; }
}
async function mineLinkedIn() {
  if (!RAPIDAPI_KEY) { log('LinkedIn: no RAPIDAPI_KEY in .env — skipping'); return []; }
  const cfg = linkedinWatchlist();
  const host = (process.env.LINKEDIN_RAPIDAPI_HOST || cfg.host || '').trim();
  if (!host || !cfg.profiles.length) { log('LinkedIn: no host/profiles in config/linkedin-watchlist.json — skipping (see linkedin-watchlist.example.json)'); return []; }
  const out = [];
  let dead = false;
  for (const prof of cfg.profiles) {
    if (dead) break;
    const url = prof.type === 'company'
      ? `https://${host}/get-company-posts?linkedin_url=${encodeURIComponent('https://www.linkedin.com/company/' + prof.slug)}&type=posts`
      : `https://${host}/get-profile-posts?linkedin_url=${encodeURIComponent('https://www.linkedin.com/in/' + prof.slug)}&type=posts`;
    const data = await safe(`linkedin:${prof.slug}`, () =>
      getJSON(url, { headers: { 'X-RapidAPI-Key': RAPIDAPI_KEY, 'X-RapidAPI-Host': host } }), null);
    if (data && data.success === false && /no longer providing/i.test(data.message || '')) {
      log(`LinkedIn: provider ${host} is DEAD ("${(data.message || '').slice(0, 80)}") — swap host in config/linkedin-watchlist.json`);
      dead = true; break;
    }
    const posts = (data && (data.data || data.posts || data.response)) || [];
    if (!Array.isArray(posts) || !posts.length) { log(`LinkedIn ${prof.name} (${prof.slug}): no posts returned — verify slug`); continue; }
    // tolerant field extraction across scraper providers
    const eng = (p) => (p.num_reactions || p.totalReactionCount || p.likeCount || p.reactions || 0)
      + (p.num_comments || p.commentsCount || p.comments || 0) * 5
      + (p.num_reposts || p.repostsCount || p.reposts || 0) * 3;
    const avg = posts.reduce((s, p) => s + eng(p), 0) / posts.length || 1;
    for (const p of posts.slice(0, 8)) {
      const text = p.text || p.commentary || p.post_text || '';
      if (!text) continue;
      const score = Math.round((eng(p) / avg) * 100);
      const hasVisual = !!(p.images || p.image || p.media || p.document || p.video);
      const fmt = p.document ? 'pdf-carousel' : p.video ? 'video' : (p.images || p.image) ? 'image' : 'text';
      const item = {
        date: ymd(),
        platform: 'LinkedIn',
        subreddit: `${prof.name}${prof.lane ? ` [${prof.lane}]` : ''}`,
        title: text.split('\n')[0].slice(0, 120),
        url: p.post_url || p.postUrl || p.url || '',
        upvotes: eng(p),
        topComment: `format:${fmt}${hasVisual ? ' +visual' : ''} | reposts:${p.num_reposts || p.repostsCount || 0}`,
        coreTension: coreTension(text),
        contentAngle: contentAngle(prof.name, text),
        hookDraft: `${classifyHook(text)}: ${text.split('\n')[0].slice(0, 80)}`,
        score,
      };
      if (score > OUTLIER_STRONG) {
        // Full reference: opening 2 lines (the LinkedIn hook), line-break
        // rhythm, visual format — exactly what the writer needs to
        // pattern-match structure (never phrasing).
        const lines = text.split('\n').filter(Boolean);
        item.refFile = saveRef('linkedin', `${prof.slug}-${(p.urn || p.post_id || p.id || '').toString().slice(-12)}`,
          `${prof.name}${prof.lane ? ` (${prof.lane} lane)` : ''} | ${fmt} | engagement ${eng(p)} (${score} vs own avg)\n` +
          `URL: ${item.url}\n` +
          `HOOK (first 2 lines):\n${lines.slice(0, 2).join('\n')}\n\n` +
          `STRUCTURE: ${lines.length} lines, avg ${Math.round(text.length / lines.length)} chars/line${hasVisual ? `, visual: ${fmt}` : ', no visual'}\n\n` +
          `FULL TEXT:\n${text.slice(0, 3000)}`);
      }
      out.push(item);
    }
    log(`LinkedIn ${prof.name}: ${posts.length} posts mined (avg eng ${Math.round(avg)})`);
  }
  out.sort((a, b) => (b.score || 0) - (a.score || 0));
  return out;
}

// ===========================================================================
// GOOGLE SHEETS WRITER (Application Default Credentials).
// Falls back to a local JSON file on any failure — no signal is ever lost.
// ===========================================================================
async function getGoogleClients() {
  const { google } = require('googleapis');
  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const client = await auth.getClient();
  return { google, client };
}

async function appendRows(tab, rows) {
  if (!rows.length) { log(`Sheets ${tab}: nothing to append`); return { ok: true, wrote: 0 }; }
  const fallbackFile = path.join(OUT_DIR, `pending-sheets-${tab.replace(/\s+/g, '_')}-${ymd()}.json`);
  try {
    if (!SHEET_ID) throw new Error('no data.google_sheet_id in config');
    const { google, client } = await getGoogleClients();
    const sheets = google.sheets({ version: 'v4', auth: client });
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${tab}!A1`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: rows },
    });
    log(`Sheets ${tab}: appended ${rows.length} rows`);
    return { ok: true, wrote: rows.length };
  } catch (e) {
    logErr(`sheets:${tab}`, e);
    fs.writeFileSync(fallbackFile, JSON.stringify(rows, null, 2));
    log(`Sheets ${tab}: write FAILED — ${rows.length} rows saved to ${path.basename(fallbackFile)} for manual import`);
    return { ok: false, wrote: 0, fallbackFile };
  }
}

// Map mined objects -> the sheet column order (see docs/sheet-template.md)
function outlierRows(vids) {
  // Daily Outlier: Date|Platform|Creator|Subscriber Count|Title|URL|Views|
  //   Outlier Score|Hook Type|Hook Text|Suggested Title|Suggested Hook|Lane|Status
  return vids.map((v) => [
    v.date, v.platform, v.creator, v.subs, v.title, v.url, v.views, v.score,
    v.hookType, v.hookText,
    suggestedTitle(v), suggestedHook(v), v.lane,
    v.tier + (v.smallChannel ? ' / <50K' : ''),
  ]);
}
function tensionRows(items) {
  // Social Pulse: Date|Platform|Source|Post Title|URL|Engagement|Top Comment|
  //   Core Tension|Content Angle|Hook Draft|Reference File|Status
  return items.map((t) => [
    t.date, t.platform || 'Reddit', t.subreddit || '', t.title, t.url, t.upvotes, t.topComment,
    t.coreTension, t.contentAngle, t.hookDraft, t.refFile || '', 'NEW',
  ]);
}

// Lightweight your-version suggestions (templated; real voice-matching happens
// in the writer stage, driven by your voice fingerprint).
function suggestedTitle(v) {
  return `Your take on: ${v.title.slice(0, 60)}`;
}
function suggestedHook(v) {
  const map = {
    'myth-bust': "Everyone repeats this — and it's wrong.",
    'confession': 'For years I believed this too.',
    'mechanism': "Here's the actual mechanism no one explains.",
    'authority': 'Years of doing this taught me the opposite.',
    'pattern-interrupt': 'Stop scrolling if this sounds familiar.',
  };
  return map[v.hookType] || map['pattern-interrupt'];
}

// ===========================================================================
// DIGEST — always saved to output/scout/; emailed if a mailer is available
// ===========================================================================
function buildDigest(vids, tensions) {
  const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const top3v = vids.slice(0, 3);
  const top3t = tensions.slice(0, 3);

  let body = `TOP OUTLIER VIDEOS TODAY:\n`;
  if (!top3v.length) body += `  (no strong outliers surfaced today)\n`;
  top3v.forEach((v, i) => {
    body += `\n  ${i + 1}. ${v.nicheRelevant ? '* ' : ''}${v.title}\n     ${v.creator} (${v.subs.toLocaleString()} subs) — score ${v.score} [${v.tier}]${v.nicheRelevant ? ' - on-niche' : ''}\n` +
            `     Hook: ${v.hookText.slice(0, 120)}\n     Suggested angle: ${suggestedTitle(v)} — "${suggestedHook(v)}"\n     ${v.url}\n`;
  });

  body += `\n\nTOP AUDIENCE TENSIONS (Reddit/Social):\n`;
  if (!top3t.length) body += `  (none surfaced today)\n`;
  top3t.forEach((t, i) => {
    body += `\n  ${i + 1}. ${t.nicheRelevant ? '* ' : ''}[${t.subreddit || t.platform}] ${t.coreTension}\n     Angle: ${t.contentAngle}\n     ${t.url}\n`;
  });

  const subject = `Daily Content Scout — ${date}`;
  return { subject, body, date };
}

async function sendDigest(digest) {
  const fallback = path.join(OUT_DIR, `digest-${ymd()}.txt`);
  const full = `Subject: ${digest.subject}\n\n${digest.body}\n`;
  // Always save a local copy so the digest is never lost
  fs.writeFileSync(fallback, full);
  const to = (CFG.approval && CFG.approval.approval_channel_email) || MAIL_SENDER;
  try {
    // Optional: if the repo has a mailer module and a recipient, email it too.
    const { sendMail } = require('./mailer');
    if (!to) throw new Error('no approval_channel_email / MAIL_SENDER configured');
    await sendMail(to, digest.subject, digest.body);
    log(`Email: digest sent to ${to}`);
    return { ok: true };
  } catch (e) {
    log(`Email: not sent (${e.message ? e.message.slice(0, 80) : e}) — digest saved to ${path.basename(fallback)}`);
    return { ok: false, fallback };
  }
}

// ===========================================================================
// MAIN RUN
// ===========================================================================
async function run() {
  log('================ TREND SCOUT RUN START ================');

  if (!(CFG.topics && CFG.topics.mode === 'scraper' && SCRAPER.enabled)) {
    log('Scout is disabled: set config.topics.mode = "scraper" and topics.scraper.enabled = true to use it.');
    log('(In "manual" topic mode the pipeline uses your manual_topics list and never calls this agent.)');
    return;
  }
  if (!YOUTUBE_KEY && !RAPIDAPI_KEY) {
    console.error(
      '\nThe trend scout needs at least one API key to do anything useful:\n' +
      '  YOUTUBE_DATA_API_KEY  — YouTube outlier mining (free from Google Cloud Console)\n' +
      '  RAPIDAPI_KEY          — X/Instagram/LinkedIn mining (your own RapidAPI subscriptions)\n' +
      'Add them to .env at the repo root (see .env.example), or switch\n' +
      'config.topics.mode to "manual" and list your own topics — no keys needed.\n');
    process.exit(1);
  }
  log(`keys: youtube=${!!YOUTUBE_KEY} rapidapi=${!!RAPIDAPI_KEY} sheet=${!!SHEET_ID}`);

  const vids = await safe('mineYouTube', mineYouTube, []);
  const reddit = await safe('mineReddit', mineReddit, []);
  const twitter = await safe('mineTwitter', mineTwitter, []);
  const instagram = await safe('mineInstagram', mineInstagram, []);
  const linkedin = await safe('mineLinkedIn', mineLinkedIn, []);
  const tensions = [...reddit, ...twitter, ...instagram, ...linkedin].sort((a, b) => (b.upvotes || 0) - (a.upvotes || 0));

  log(`MINED: ${vids.length} outlier videos, ${tensions.length} tensions (reddit=${reddit.length} twitter=${twitter.length} ig=${instagram.length} linkedin=${linkedin.length})`);

  // ---- CURATION: surface only NOTABLE items — on-niche AND/OR high-performing —
  // not every mined piece (otherwise the digest is overwhelming). An on-niche
  // keyword match weights an item up 2.5x; cap what reaches the sheet + digest.
  // The keyword list comes straight from config.topics.niche_keywords, e.g. for
  // an urban-gardening brand: ["container garden", "balcony", "compost", ...].
  const nicheRe = NICHE_KEYWORDS.length
    ? new RegExp(NICHE_KEYWORDS.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i')
    : null;
  const nicheRelevant = (o) => !!(nicheRe && nicheRe.test(`${o.title || ''} ${o.hookText || ''} ${o.coreTension || ''} ${o.contentAngle || ''} ${o.subreddit || ''}`));
  const notability = (o) => (o.score || o.upvotes || 0) * (nicheRelevant(o) ? 2.5 : 1);
  const curate = (arr, cap) => arr.map((o) => ({ ...o, nicheRelevant: nicheRelevant(o) })).sort((a, b) => notability(b) - notability(a)).slice(0, cap);
  const vidsCur = curate(vids, 12);
  const tensionsCur = curate(tensions, 12);
  log(`CURATED: vids ${vids.length} -> ${vidsCur.length} (${vidsCur.filter((v) => v.nicheRelevant).length} on-niche), tensions ${tensions.length} -> ${tensionsCur.length} (${tensionsCur.filter((t) => t.nicheRelevant).length} on-niche)`);

  const sheetVid = await appendRows('Daily Outlier', outlierRows(vidsCur));
  const sheetTen = await appendRows('Social Pulse', tensionRows(tensionsCur));

  const digest = buildDigest(vidsCur, tensionsCur);
  const mail = await sendDigest(digest);

  log(`SUMMARY: outliers=${vids.length} tensions=${tensions.length} ` +
      `sheetsOutlier=${sheetVid.ok ? 'ok' : 'fallback'} sheetsTension=${sheetTen.ok ? 'ok' : 'fallback'} ` +
      `digest=${mail.ok ? 'emailed' : 'saved locally'}`);
  log('================ TREND SCOUT RUN END ==================\n');

  return { vids, tensions, digest, sheetVid, sheetTen, mail };
}

// ---------------------------------------------------------------------------
// Entry — always runs once; scheduling belongs to the orchestrator, not here.
// ---------------------------------------------------------------------------
if (require.main === module) {
  run().then(() => process.exit(0)).catch((e) => { logErr('main', e); process.exit(1); });
}

module.exports = { run, mineYouTube, mineReddit, mineLinkedIn, classifyHook };
