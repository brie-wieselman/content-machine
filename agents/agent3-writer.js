#!/usr/bin/env node
/* ============================================================================
 * AGENT 3 — CONTENT WRITER
 *
 * The core writing stage of the Content Machine. Takes a topic — from your
 * config's manual list, a --topic argument, or (in scraper mode) rows in your
 * Google Sheet's "Research" tab — and produces a complete content package:
 *
 *   • a long-form article draft (if articles are enabled in config)
 *   • platform-specific social copy for every platform you enabled
 *   • a visual-format suggestion for the Canva stage (agent3c)
 *
 * The package is saved to output/pending/ as markdown, the article draft to
 * output/articles/, and an approval-request email goes to you. Nothing is
 * scheduled until you approve (see pipeline.js and the approval handler).
 *
 * Usage:
 *   node agents/agent3-writer.js --topic "your idea here"      one-off run
 *   node agents/agent3-writer.js --config config/config.json   scheduled run
 *
 * Generation uses the Anthropic Messages API (ANTHROPIC_API_KEY in .env).
 * With no key, a clearly-labelled template scaffold is produced instead so
 * the pipeline plumbing stays testable end-to-end.
 *
 * Operating rule: log and continue — a scheduled run must never crash.
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

// ---------------------------------------------------------------------------
// Paths + CLI args
// ---------------------------------------------------------------------------
const ROOT = path.resolve(__dirname, '..'); // repo root (agents/ is one level down)

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? (process.argv[i + 1] || '') : '';
}
const CONFIG_PATH = path.resolve(ROOT, argValue('--config') || path.join('config', 'config.json'));

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch (_) {
    console.error(`Missing or invalid config at ${CONFIG_PATH} — copy config/config.example.json to config/config.json and fill it in (see ONBOARDING.md).`);
    process.exit(1);
  }
}
const CFG = loadConfig();

const PENDING = path.join(ROOT, 'output', 'pending');
const ARTICLES = path.resolve(ROOT, (CFG.articles && CFG.articles.output_dir) || path.join('output', 'articles'));
const LOG_DIR = path.join(ROOT, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'writer-log.txt');
[PENDING, ARTICLES, LOG_DIR].forEach((d) => fs.mkdirSync(d, { recursive: true }));

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
const ts = () => new Date().toISOString();
function log(m) { const l = `[${ts()}] ${m}`; console.log(l); try { fs.appendFileSync(LOG_FILE, l + '\n'); } catch (_) {} }
function logErr(s, e) { log(`ERROR [${s}]: ${e && e.message ? e.message : e}`); }
async function safe(s, fn, fb) { try { return await fn(); } catch (e) { logErr(s, e); return fb; } }
const ymd = () => new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Env — one repo-root .env, dotenv-style KEY=value lines. Expected keys:
//   ANTHROPIC_API_KEY   required for real generation
//   ANTHROPIC_MODEL     optional model override
//   MAIL_SENDER         the address the approval email is sent from
//   SCHEDULER_API_KEY   used by the scheduler agent (Blotato), not here
//   YOUTUBE_DATA_API_KEY / RAPIDAPI_KEY  only if you enabled the scraper
// ---------------------------------------------------------------------------
function loadEnv() {
  const env = {};
  try {
    fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/).forEach((ln) => {
      const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) env[m[1]] = m[2].trim();
    });
  } catch (_) { log('WARN: no .env at repo root — using process env only'); }
  return env;
}
const ENV = loadEnv();
function envVal(...keys) {
  for (const k of keys) { const v = (ENV[k] || process.env[k] || '').trim(); if (v && !/^\[.*\]$/.test(v)) return v; }
  return '';
}
const ANTHROPIC_KEY = envVal('ANTHROPIC_API_KEY');
const MODEL = envVal('ANTHROPIC_MODEL') || 'claude-sonnet-5';
const MAIL_SENDER = envVal('MAIL_SENDER');
const SHEET_ID = (CFG.data && CFG.data.google_sheet_id) || '';
const APPROVAL_EMAIL = (CFG.approval && CFG.approval.approval_channel_email) || MAIL_SENDER;

// ---------------------------------------------------------------------------
// Anthropic transport — curl, streaming. Two hard-won lessons baked in:
//
// 1. --http1.1: large POST bodies intermittently died with "curl: (16) Error
//    in the HTTP2 framing layer" on some home networks. HTTP/1.1 avoids it.
// 2. STREAMING is mandatory, not an optimization: some networks/routers kill
//    any HTTP response that has sent no bytes for ~60s. A multi-platform
//    package takes 60–90s to generate, so non-streaming calls sat at the
//    razor's edge and failed intermittently — which silently degraded the
//    engine to its template fallback. With stream:true the server sends SSE
//    bytes from the first token and the connection is never idle. The SSE
//    events are reassembled below into the classic non-streaming message
//    shape ({content, stop_reason, usage}) so callers don't care.
//
// Node's built-in fetch is also prone to reusing dead keep-alive sockets
// under scheduled (launchd/cron) runs — curl with a hard --max-time fails
// fast and opens a fresh connection each time, so the retry loop actually
// rides out a transient blip instead of hanging for half an hour.
// ---------------------------------------------------------------------------
function anthropicPost(body, timeoutSec = 300) {
  const tmp = path.join(os.tmpdir(), `anthropic-req-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify({ ...body, stream: true }));
  try {
    const out = execSync(
      `curl -sS -N --http1.1 --max-time ${timeoutSec} -w '\\n===HTTP_STATUS===%{http_code}' ` +
      `-X POST https://api.anthropic.com/v1/messages ` +
      `-H "x-api-key: $ANTHROPIC_KEY" -H "anthropic-version: 2023-06-01" ` +
      `-H "anthropic-beta: prompt-caching-2024-07-31" ` +
      `-H "content-type: application/json" --data-binary @${tmp}`,
      { encoding: 'utf8', timeout: (timeoutSec + 15) * 1000, maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, ANTHROPIC_KEY } }
    );
    const statusM = out.match(/===HTTP_STATUS===(\d+)\s*$/);
    const status = statusM ? Number(statusM[1]) : 0;
    const payload = out.replace(/\n?===HTTP_STATUS===\d+\s*$/, '');
    if (status < 200 || status >= 300) {
      // Error responses are plain JSON, not SSE.
      let json = null; try { json = JSON.parse(payload); } catch (_) { json = { raw: payload.slice(0, 400) }; }
      return { ok: false, status, json };
    }
    return { ok: true, status, json: assembleSse(payload) };
  } catch (e) {
    const stderr = (e.stderr || '').toString().trim().slice(0, 300);
    if (stderr) e.message = `curl exit ${e.status}: ${stderr}`;
    throw e;
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
}

// Reassemble an SSE stream into the classic non-streaming message shape.
function assembleSse(sse) {
  const msg = { content: [], stop_reason: null, usage: {}, type: 'message' };
  const partials = {}; // index -> accumulated partial_json for tool_use blocks
  for (const line of sse.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    let ev; try { ev = JSON.parse(line.slice(5).trim()); } catch (_) { continue; }
    if (ev.type === 'message_start' && ev.message) { msg.usage = ev.message.usage || {}; }
    else if (ev.type === 'content_block_start') {
      msg.content[ev.index] = { ...ev.content_block };
      if (ev.content_block.type === 'tool_use') { partials[ev.index] = ''; msg.content[ev.index].input = {}; }
      if (ev.content_block.type === 'text' && msg.content[ev.index].text === undefined) msg.content[ev.index].text = '';
    } else if (ev.type === 'content_block_delta') {
      const blk = msg.content[ev.index]; if (!blk) continue;
      if (ev.delta.type === 'text_delta') blk.text = (blk.text || '') + ev.delta.text;
      else if (ev.delta.type === 'input_json_delta') partials[ev.index] = (partials[ev.index] || '') + ev.delta.partial_json;
    } else if (ev.type === 'content_block_stop') {
      const blk = msg.content[ev.index];
      if (blk && blk.type === 'tool_use' && partials[ev.index] !== undefined) {
        // Models sometimes emit raw control chars inside JSON string values
        // (same reason sanitizeJson exists for the text path) — sanitize
        // before parsing, and log the reason if it still fails.
        const raw = partials[ev.index] || '{}';
        try { blk.input = JSON.parse(raw); }
        catch (_) {
          try { blk.input = JSON.parse(sanitizeJson(raw)); }
          catch (e2) { log(`assembleSse: tool_use input unparseable (${e2.message}) head="${raw.slice(0, 160)}"`); blk.input = {}; }
        }
      }
    } else if (ev.type === 'message_delta') {
      if (ev.delta && ev.delta.stop_reason) msg.stop_reason = ev.delta.stop_reason;
      if (ev.usage) msg.usage = { ...msg.usage, ...ev.usage };
    } else if (ev.type === 'error') {
      msg.type = 'error'; msg.error = ev.error;
    }
  }
  msg.content = msg.content.filter(Boolean);
  return msg;
}

// ---------------------------------------------------------------------------
// JSON repair — models sometimes emit invalid JSON in large outputs.
// ---------------------------------------------------------------------------
// Escape raw control characters (newlines/tabs/CRs) that models often emit
// INSIDE JSON string values, which is invalid JSON and breaks JSON.parse.
function sanitizeJson(s) {
  let out = '', inStr = false, esc = false;
  for (const ch of s) {
    if (esc) { out += ch; esc = false; continue; }
    if (ch === '\\') { out += ch; esc = true; continue; }
    if (ch === '"') { inStr = !inStr; out += ch; continue; }
    if (inStr) {
      if (ch === '\n') { out += '\\n'; continue; }
      if (ch === '\r') { out += '\\r'; continue; }
      if (ch === '\t') { out += '\\t'; continue; }
    }
    out += ch;
  }
  return out;
}

// Best-effort repair for a SECOND large-output JSON failure mode: unescaped
// double-quotes INSIDE string values (…called "normal" by the tool…).
// Heuristic: a quote only closes a string if the next non-space char is
// structural (, } ] :) or end-of-input; otherwise it's content — escape it.
// Applied only AFTER strict parse fails.
function repairJsonQuotes(s) {
  let out = '', inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (esc) { out += ch; esc = false; continue; }
    if (ch === '\\') { out += ch; esc = true; continue; }
    if (ch === '"') {
      if (!inStr) { inStr = true; out += ch; continue; }
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j])) j++;
      if (j >= s.length || ',}]:'.includes(s[j])) { inStr = false; out += ch; }
      else out += '\\"'; // content quote — escape it
      continue;
    }
    out += ch;
  }
  return out;
}
function parseLoose(raw) {
  try { return JSON.parse(raw); } catch (_) {}
  try { return JSON.parse(sanitizeJson(raw)); } catch (_) {}
  return JSON.parse(repairJsonQuotes(sanitizeJson(raw)));
}

// ---------------------------------------------------------------------------
// Voice context — the two config-supplied files that make output sound like
// YOU: the voice fingerprint (checkable rules extracted from your real
// writing) and your content-rules canon. brand-context.js extracts the canon
// by heading so a growing doc never silently truncates the rules that matter.
// ---------------------------------------------------------------------------
function loadVoiceContext() {
  const bc = require('./brand-context');
  const read = (rel, label) => {
    const p = path.resolve(ROOT, rel);
    try { const t = fs.readFileSync(p, 'utf8'); log(`voice: loaded ${label} (${rel})`); return t; }
    catch (_) { log(`voice: ${label} not found at ${rel} — continuing without it`); return ''; }
  };
  const voice = read((CFG.voice && CFG.voice.fingerprint_file) || 'config/voice-fingerprint.md', 'voice fingerprint');
  const contentDoc = read((CFG.voice && CFG.voice.content_rules_file) || 'config/content-rules.md', 'content rules');
  const ctx = bc.buildBrandContext({ voice, hooks: '', contentDoc });
  log(`voice: context assembled (${ctx.length} chars)`);
  return ctx;
}

// Banned phrases: a small default list of generic-AI filler, plus whatever
// you add in config.voice.banned_phrases (optional).
const DEFAULT_BANNED = [
  'game-changer', 'game changer', 'revolutionize', 'delve',
  "in today's fast-paced world", 'unlock the secret', 'elevate your',
];
function bannedPhrases() {
  return [...new Set([...DEFAULT_BANNED, ...((CFG.voice && CFG.voice.banned_phrases) || [])])];
}

// ---------------------------------------------------------------------------
// Platforms + visual formats — everything comes from config.
// ---------------------------------------------------------------------------
function enabledPlatforms() {
  return Object.entries(CFG.platforms || {})
    .filter(([k, v]) => v === true && !k.startsWith('_'))
    .map(([k]) => k);
}
const PLATFORM_FIELD = {
  linkedin: 'FULL LinkedIn post COPY — long-form, generous line breaks, ends with a question. The actual words to post, never a routing note.',
  instagram: 'FULL Instagram caption COPY: hook line + body + CTA. The actual words to post.',
  tiktok: 'Short TikTok caption: 1–2 lines plus up to 3 hashtags.',
  threads: 'Threads post: MAX 3 short declarative lines — the sharpest distillation. Text-only; never reference a carousel or swipe.',
  x: 'X/Twitter post: same angle as Threads but REWORDED (never copy-paste). Concise.',
  facebook: 'Facebook caption — may take the Instagram angle, but reworded.',
  pinterest: 'Pin title + description: keyword-rich and genuinely useful.',
};
function visualFormats() {
  return Object.keys((CFG.visual && CFG.visual.canva_templates) || {}).filter((k) => !k.startsWith('_'));
}

// ---------------------------------------------------------------------------
// On-topic gate — cheap guardrail applied to SCRAPED topics only. Manual
// topics and --topic runs bypass it (you chose those yourself). Same
// philosophy as brand-context.isOnTopic: unknown topics are rejected, because
// a trend scraper will eventually surface something wildly off-niche and the
// engine must not spend API calls (or your credibility) on it.
// ---------------------------------------------------------------------------
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function isOnTopicByConfig(topic) {
  const kws = ((CFG.topics && CFG.topics.niche_keywords) || []).map(String).filter(Boolean);
  if (!kws.length) return true; // no keywords configured = gate off
  return new RegExp('\\b(' + kws.map(escRe).join('|') + ')\\b', 'i').test(String(topic || ''));
}

// ---------------------------------------------------------------------------
// Hook scoring (heuristic cross-check). Hook = 50% of the weight; the model
// self-scores during generation and this heuristic only backstops it.
// ---------------------------------------------------------------------------
function scoreHook(hook) {
  const h = (hook || '').trim();
  const lo = h.toLowerCase();
  let hookStrength = 0;
  if (/^(your|you|why|stop|nobody|no one|everyone|i |the )/i.test(h)) hookStrength += 2.5; // direct / second-person open
  if (h.length <= 90) hookStrength += 1;                       // scannable
  if (/[?]/.test(h)) hookStrength += 1;                        // open loop
  if (/\d/.test(h)) hookStrength += 0.5;                       // specificity (numbers)
  hookStrength = Math.min(5, hookStrength);                    // 50% weight, max 5

  const curiosity = /\?|why|until|but|still|the real|what no one/i.test(lo) ? 1.5 : 0.5;
  const emotion = /(frustrated|tired|stuck|wasted|ignored|overwhelmed|wrong|finally)/i.test(lo) ? 1.5 : 0.5;
  const share = (h.length <= 100 && /[?:]/.test(h)) ? 1 : 0.5;
  const voice = bannedPhrases().some((b) => lo.includes(b.toLowerCase())) ? -1 : 0.8; // penalize filler
  const polarity = /(wrong|isn't|not|stop|myth|actually|the problem)/i.test(lo) ? 0.7 : 0.3;

  let total = hookStrength + curiosity + emotion + share + voice + polarity;
  total = Math.max(0, Math.min(10, total));
  return Math.round(total * 10) / 10;
}

function improveHook(hook) {
  // Strengthen by APPENDING a grammatical open-loop clause — never by
  // prepending words (that once produced garbled openings like "Your i
  // built…"). Tail words are chosen to hit the scorer's curiosity/polarity
  // signals while reading as natural English.
  const h = hook.replace(/\s*[—-]\s*and here'?s why\s*$/i, '').trim().replace(/[.]$/, '');
  if (/[?]/.test(h) || /almost nobody|what everyone skips/i.test(h)) return h; // already strong
  const tails = [
    " — and it isn't what you think",
    ' — and almost nobody checks it',
    " — here's what that actually costs you",
  ];
  return h + tails[h.length % tails.length];
}

function scoredHook(initialHook) {
  let hook = initialHook;
  let score = scoreHook(hook);
  let rewrites = 0;
  while (score < 6 && rewrites < 3) { hook = improveHook(hook); score = scoreHook(hook); rewrites++; }
  return { hook, score, rewrites };
}

// ---------------------------------------------------------------------------
// FALLBACK scaffold (no Anthropic key, or every retry failed). Deliberately
// generic and clearly labelled — its job is to keep the plumbing testable,
// not to ship. Whatever your niche (say, urban gardening), a real run with a
// key replaces this entirely.
// ---------------------------------------------------------------------------
function slugify(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50); }
function firstSentence(s) { return (s.split(/[.\n]/)[0] || s).trim(); }

function fallbackPackage(topic) {
  const gist = firstSentence(topic);
  const { hook, score, rewrites } = scoredHook(`${gist} — and the part everyone skips.`);
  const pkg = {
    hook, viralScore: score, rewrites,
    hashtags: [],
    visual_format: `${visualFormats()[0] || 'quote_card'} — fallback default`,
  };
  for (const p of enabledPlatforms()) {
    pkg[p] = `[FALLBACK DRAFT — set ANTHROPIC_API_KEY for real generation]\n${hook}\n\n` +
      `Write 3–5 sentences here in your own voice about "${gist}": what people usually get wrong, ` +
      `why that happens, and one concrete step. End with a question your audience can answer in a few words.`;
  }
  if (CFG.articles && CFG.articles.enabled) {
    pkg.article = `# ${gist}\n\n[FALLBACK DRAFT — set ANTHROPIC_API_KEY for real generation]\n\n` +
      `Outline:\n1. What most advice gets wrong about ${gist.toLowerCase()}\n` +
      `2. Why that happens\n3. What to do instead, step by step\n4. Common questions\n`;
  }
  return pkg;
}

// ---------------------------------------------------------------------------
// Anthropic generation (primary path).
// ---------------------------------------------------------------------------
function packageSchema() {
  const props = {
    hook: { type: 'string', description: 'The opening line only — the scroll-stopper. Written FIRST, before any body copy.' },
    viralScore: { type: 'number', description: 'Honest 1–10 attention score for the FINAL hook. Must be >= 8 (rewrite the hook until it is).' },
    hashtags: { type: 'array', items: { type: 'string' }, description: 'Up to 5 hashtags, no # needed. Never include banned phrases here either.' },
    visual_format: { type: 'string', description: `Which visual template fits best (${visualFormats().join(' | ') || 'quote_card | listicle | single_stat'}) + a one-line reason. This routes the Canva stage.` },
  };
  const required = ['hook', 'viralScore', 'visual_format'];
  if (CFG.articles && CFG.articles.enabled) {
    props.article = { type: 'string', description: 'Complete 800–1200 word markdown article: an H1 title, question-style H2 sections an answer engine can lift whole, plain language a general reader follows, fully self-contained (no internal shorthand).' };
    required.push('article');
  }
  for (const p of enabledPlatforms()) {
    props[p] = { type: 'string', description: PLATFORM_FIELD[p] || `FULL post copy for ${p}. The actual words to post.` };
    required.push(p);
  }
  return { type: 'object', properties: props, required };
}

function buildSystemPrompt(voiceCtx) {
  const brand = CFG.brand || {};
  const platforms = enabledPlatforms();
  return `You are the content writer for ${brand.name || 'this brand'} (${brand.handle || 'no handle set'}). ${brand.one_line || ''}\n\n` +
    `Follow these voice + content rules exactly:\n${voiceCtx.slice(0, 60000)}\n\n` +
    `RULES:\n` +
    `- HOOK FIRST: write the strongest possible opening line before anything else. Score it honestly 1-10 on whether it stops the scroll in 3 seconds (hook = 50% of the weight). If it scores below 8, REWRITE it until it does — then put that final score in viralScore. Never emit a hook below 8.\n` +
    `- BANNED PHRASES (never use, anywhere, including hashtags and metadata): ${bannedPhrases().join(' · ')}.\n` +
    `- Threads and X must carry the same angle but be REWORDED — never copy-paste between them.\n` +
    `- Instagram: at most 5 hashtags.\n` +
    `- Every piece must read as a complete, self-contained explanation — a first-time reader needs no prior context and no internal shorthand.\n` +
    `- Platforms to write for: ${platforms.join(', ') || '(none enabled — article only)'}.\n` +
    (CFG.articles && CFG.articles.enabled ? `- Also write the full article (see the article field description).\n` : '') +
    `\nCall the emit_package tool with the complete package.`;
}

// Recent human rejections are the best teacher the engine has: surface the
// last few edit notes so the model corrects course instead of repeating them.
function recentRejectionNotes() {
  try {
    const rlog = path.join(LOG_DIR, 'rejection-log.jsonl');
    if (!fs.existsSync(rlog)) return '';
    const lines = fs.readFileSync(rlog, 'utf8').trim().split('\n').filter(Boolean).slice(-10)
      .map((l) => { try { const j = JSON.parse(l); return `• [${(j.ts || '').slice(0, 10)}] "${j.topic}": ${j.note}`; } catch (_) { return null; } })
      .filter(Boolean);
    if (!lines.length) return '';
    return `\n\nLEARN FROM RECENT REJECTIONS (your editor's own notes — apply these now):\n${lines.join('\n')}`;
  } catch (_) { return ''; }
}

async function generatePackage(topic, voiceCtx) {
  if (!ANTHROPIC_KEY) {
    log('GENERATION: no ANTHROPIC_API_KEY — using labelled FALLBACK scaffold');
    return { mode: 'fallback', pkg: fallbackPackage(topic) };
  }
  // Retry on transient truncation/transport hiccups. Backoff is deliberately
  // WIDE (60s/120s/180s): observed API/network flaps last ~10 minutes, and a
  // tight 2s/4s/6s backoff burns every attempt inside the outage window —
  // spreading 4 attempts across ~10 min lets one land past the flap.
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const body = {
        model: MODEL,
        max_tokens: 16000,
        system: [{ type: 'text', text: buildSystemPrompt(voiceCtx), cache_control: { type: 'ephemeral' } }],
        tools: [{ name: 'emit_package', description: 'Emit the complete content package.', input_schema: packageSchema() }],
        tool_choice: { type: 'tool', name: 'emit_package' },
        messages: [{ role: 'user', content: `Content topic / idea:\n${topic}${recentRejectionNotes()}` }],
      };
      const res = anthropicPost(body, 120);
      if (!res.ok) throw new Error(`Anthropic HTTP ${res.status} ${JSON.stringify(res.json).slice(0, 200)}`);
      const j = res.json;
      const toolUse = (j.content || []).find((c) => c.type === 'tool_use' && c.name === 'emit_package');
      if (!toolUse || !toolUse.input || !toolUse.input.hook) {
        const types = (j.content || []).map((c) => c.type).join(',');
        throw new Error(`no usable tool_use (stop=${j.stop_reason}, blocks=[${types}], err=${j.type === 'error' ? JSON.stringify(j.error) : 'n/a'})`);
      }
      const pkg = toolUse.input;
      // On large forced-tool calls the model occasionally double-encodes a
      // nested value as a JSON STRING. Unwrap rather than throwing the whole
      // response away — the content is valid, just wrapped.
      for (const k of Object.keys(pkg)) {
        if (k === 'hashtags' && typeof pkg[k] === 'string') {
          try { pkg[k] = parseLoose(pkg[k]); } catch (_) { pkg[k] = pkg[k].split(/[,\s]+/).filter(Boolean); }
        }
      }
      pkg.viralScore = Math.max(1, Math.min(10, Number(pkg.viralScore) || scoreHook(pkg.hook)));
      pkg.rewrites = 0;
      if (pkg.viralScore < 6) pkg.viralScore = scoredHook(pkg.hook).score; // last-resort safety
      log(`GENERATION: Claude API ok via tool-use (stop=${j.stop_reason})`);
      return { mode: 'claude', pkg };
    } catch (e) {
      logErr('anthropic', e);
      if (attempt < 4) { log(`GENERATION: retrying Claude API (attempt ${attempt + 1}/4)…`); await new Promise((r) => setTimeout(r, 60000 * attempt)); continue; }
    }
  }
  // LAST RESORT BEFORE THE TEMPLATE: a plain-text (no tool-use) call. Forced
  // tool-use can intermittently return an empty input; asking for raw JSON is
  // more robust, and model-written copy beats the template every time.
  try {
    const pkg = await generatePackageText(topic, voiceCtx);
    if (pkg) { log('GENERATION: Claude API ok via text-JSON fallback'); return { mode: 'claude', pkg }; }
  } catch (e) { logErr('anthropic-text-fallback', e); }
  log('GENERATION: Claude unavailable after all retries — using labelled FALLBACK scaffold');
  return { mode: 'fallback', pkg: fallbackPackage(topic) };
}

// Plain-text generation (no tool-use). Returns the same package shape.
async function generatePackageText(topic, voiceCtx) {
  const platforms = enabledPlatforms();
  const shape = {
    hook: '...', viralScore: 9, hashtags: ['', ''],
    visual_format: (visualFormats()[0] || 'quote_card') + ' — reason',
  };
  if (CFG.articles && CFG.articles.enabled) shape.article = '# Title\\n\\nfull markdown article...';
  for (const p of platforms) shape[p] = '...';
  const sys = buildSystemPrompt(voiceCtx) +
    `\n\nIGNORE the tool instruction above. Instead return ONLY valid JSON (no prose, no markdown fences) of this exact shape:\n${JSON.stringify(shape)}`;
  const res = anthropicPost({
    model: MODEL, max_tokens: 16000,
    system: [{ type: 'text', text: sys, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: `Content topic / idea:\n${topic}` }],
  }, 120);
  if (!res.ok) throw new Error(`Anthropic HTTP ${res.status} ${JSON.stringify(res.json).slice(0, 200)}`);
  let txt = (res.json.content || []).filter((c) => c.type === 'text').map((c) => c.text || '').join('').trim();
  txt = txt.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const start = txt.indexOf('{'); const end = txt.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('no JSON object in text response');
  const pkg = parseLoose(txt.slice(start, end + 1)); // tolerant of control chars + unescaped inner quotes
  if (!pkg.hook) throw new Error('no hook in parsed JSON');
  pkg.viralScore = Math.max(1, Math.min(10, Number(pkg.viralScore) || scoreHook(pkg.hook)));
  pkg.rewrites = 0;
  return pkg;
}

// Post-generation guard: log any banned phrase that slipped into copy. The
// grader (quality-monitor) also catches these; this is early visibility.
function flagBannedPhrases(pkg) {
  const hits = [];
  for (const [k, v] of Object.entries(pkg)) {
    if (typeof v !== 'string') continue;
    for (const b of bannedPhrases()) {
      if (new RegExp('\\b' + escRe(b) + '\\b', 'i').test(v)) hits.push(`"${b}" in ${k}`);
    }
  }
  if (hits.length) log(`WARN: banned phrases in generated copy: ${hits.join('; ')} — the grader will flag these; tighten your content-rules doc if it recurs.`);
}

// ---------------------------------------------------------------------------
// Markdown rendering — this exact file is what the grader reads and what you
// review. NOTE: quality-monitor.js pattern-matches the "**Generation mode:**
// FALLBACK" line to detect template floods — keep that line's format stable.
// ---------------------------------------------------------------------------
function renderMarkdown(topic, source, out) {
  const p = out.pkg;
  let md = `# Content Package — ${topic}\n\n`;
  md += `- **Date:** ${ymd()}\n- **Source:** ${source}\n`;
  md += `- **Generation mode:** ${out.mode === 'claude' ? 'Claude API' : 'FALLBACK (no ANTHROPIC_API_KEY — templated scaffold)'}\n`;
  md += `- **Hook score:** ${p.viralScore}/10${p.rewrites ? ` (rewritten ${p.rewrites}x)` : ''}\n\n`;
  md += `**Hook:** ${p.hook}\n\n---\n`;
  for (const plat of enabledPlatforms()) {
    if (p[plat]) md += `\n## ${plat.charAt(0).toUpperCase() + plat.slice(1)}\n${p[plat]}\n`;
  }
  if (Array.isArray(p.hashtags) && p.hashtags.length) {
    md += `\n**Hashtags:** ${p.hashtags.map((h) => (String(h).startsWith('#') ? h : '#' + h)).join(' ')}\n`;
  }
  if (p.visual_format) md += `\n## Visual format\n${p.visual_format}\n`;
  if (p.article) md += `\n---\n\n## Article draft\n\n${p.article}\n`;
  return md;
}

// ---------------------------------------------------------------------------
// Google Sheets (scraper mode only) — the sheet is the engine's database.
// ---------------------------------------------------------------------------
async function getGoogle() {
  const { google } = require('googleapis');
  const auth = new google.auth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  return { google, client: await auth.getClient() };
}

const SHEET_TAB = 'Research'; // see docs/sheet-template.md

async function readNewResearchRows() {
  const { google, client } = await getGoogle();
  const sheets = google.sheets({ version: 'v4', auth: client });
  const r = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${SHEET_TAB}!A1:N1000` });
  const rows = r.data.values || [];
  const header = rows[0] || [];
  const statusIdx = header.indexOf('Status');
  const topicIdx = Math.max(header.indexOf('Topic'), 0);
  const items = [];
  for (let i = 1; i < rows.length; i++) {
    if ((rows[i][statusIdx] || '').trim().toLowerCase() === 'new') items.push({ rowNumber: i + 1, cells: rows[i], topicIdx });
  }
  return { sheets, statusIdx, items };
}

async function setStatus(sheets, rowNumber, statusIdx, value) {
  const colLetter = String.fromCharCode(65 + statusIdx);
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID, range: `${SHEET_TAB}!${colLetter}${rowNumber}`,
    valueInputOption: 'RAW', requestBody: { values: [[value]] },
  });
}

// ---------------------------------------------------------------------------
// Approval email — the human gate. Dedup prevents rerun spam.
// ---------------------------------------------------------------------------
function alreadyEmailedToday(slug) {
  try {
    const txt = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, 'utf8') : '';
    return txt.includes(`approval email sent | date=${ymd()} | slug=${slug}`);
  } catch (_) { return false; }
}

async function sendApprovalEmail(topic, source, out, filePath) {
  const slug = slugify(topic);
  const subject = `Content Package Ready — ${topic} — ${ymd()}`;
  let body = `Topic: ${topic}\nSource: ${source}\nGeneration: ${out.mode === 'claude' ? 'Claude API' : 'FALLBACK (no ANTHROPIC_API_KEY)'}\n\n`;
  body += `HOOK (${out.pkg.viralScore}/10):\n  "${out.pkg.hook}"\n\nFull package:\n${filePath}\n\n`;
  body += `TO APPROVE: reply "APPROVE" to queue for scheduling,\nor "EDIT your note" to request a revision.\n(Approval is picked up by the approval handler, which invokes the scheduler.)\n`;

  if (!APPROVAL_EMAIL) { log('Email: no approval_channel_email configured and no MAIL_SENDER — skipping approval email'); return { ok: false, subject, body }; }
  if (alreadyEmailedToday(slug)) {
    log(`Email: DEDUP — approval email already sent today for slug=${slug}. Skipping.`);
    return { ok: true, deduped: true, subject, body };
  }
  const fallbackFile = path.join(LOG_DIR, `approval-email-${ymd()}-${slug}.txt`);
  fs.writeFileSync(fallbackFile, `To: ${APPROVAL_EMAIL}\nSubject: ${subject}\n\n${body}`);
  try {
    const { sendMail } = require('./mailer');
    const id = await sendMail(APPROVAL_EMAIL, subject, body);
    log(`approval email sent | date=${ymd()} | slug=${slug} | mailId=${id}`);
    return { ok: true, subject, body };
  } catch (e) {
    logErr('mail', e);
    log(`Email: send FAILED — saved to ${path.basename(fallbackFile)}`);
    return { ok: false, subject, body, fallbackFile };
  }
}

// ---------------------------------------------------------------------------
// Process one topic end-to-end
// ---------------------------------------------------------------------------
async function processTopic(topic, source, voiceCtx) {
  const out = await generatePackage(topic, voiceCtx);
  flagBannedPhrases(out.pkg);
  const md = renderMarkdown(topic, source, out);
  const slug = slugify(topic);
  const file = path.join(PENDING, `agent3-${ymd()}-${slug}.md`);
  fs.writeFileSync(file, md);
  log(`Saved package: ${file}`);
  if (out.pkg.article && CFG.articles && CFG.articles.enabled) {
    const artFile = path.join(ARTICLES, `${ymd()}-${slug}.md`);
    fs.writeFileSync(artFile, out.pkg.article + '\n');
    log(`Saved article draft: ${artFile}`);
  }
  const mail = await sendApprovalEmail(topic, source, out, file);
  return { out, file, mail };
}

// ---------------------------------------------------------------------------
// Manual-topic bookkeeping — one topic per run, so a short list in config
// lasts several scheduled runs instead of burning in one morning.
// ---------------------------------------------------------------------------
const PROCESSED_FILE = path.join(LOG_DIR, 'processed-topics.json');
function loadProcessed() { try { return JSON.parse(fs.readFileSync(PROCESSED_FILE, 'utf8')); } catch (_) { return []; } }
function saveProcessed(list) { try { fs.writeFileSync(PROCESSED_FILE, JSON.stringify(list, null, 2)); } catch (_) {} }

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------
async function main() {
  log('================ CONTENT WRITER RUN START ================');
  const voiceCtx = loadVoiceContext();
  const manualTopic = argValue('--topic');

  if (manualTopic) {
    // MODE 1 — one-off manual topic from the command line.
    log(`MODE: manual --topic "${manualTopic}"`);
    const r = await processTopic(manualTopic, 'manual --topic', voiceCtx);
    log(`SUMMARY: mode=${r.out.mode} file=${path.basename(r.file)} email=${r.mail.ok ? 'sent' : 'not sent'}`);
  } else if ((CFG.topics && CFG.topics.mode) === 'scraper' && SHEET_ID) {
    // MODE 2 — scraper: process Research-tab rows with Status=New (written by
    // the scout agent). The on-topic gate rejects off-niche scraped rows.
    log('MODE: scraper (Research tab, Status=New)');
    const data = await safe('readSheet', readNewResearchRows, null);
    if (!data) { log('Could not read sheet — aborting scraper run (logged).'); }
    else if (!data.items.length) { log('No rows with Status=New. Nothing to do.'); }
    else {
      for (const item of data.items) {
        const topic = item.cells[item.topicIdx] || 'Research row idea';
        if (!isOnTopicByConfig(topic)) {
          log(`TOPIC-GATE: skipping off-niche topic "${topic}" — no niche_keywords matched. Set Status=Skip in the sheet to suppress this log.`);
          await safe(`status:skip:${item.rowNumber}`, () => setStatus(data.sheets, item.rowNumber, data.statusIdx, 'Skipped-OffTopic'), null);
          continue;
        }
        await safe(`status:inprogress:${item.rowNumber}`, () => setStatus(data.sheets, item.rowNumber, data.statusIdx, 'In Progress'), null);
        const r = await safe(`process:${item.rowNumber}`, () => processTopic(topic, `Research row ${item.rowNumber}`, voiceCtx), null);
        await safe(`status:done:${item.rowNumber}`, () => setStatus(data.sheets, item.rowNumber, data.statusIdx, r ? 'Done' : 'New'), null);
        log(`Processed row ${item.rowNumber}: ${r ? 'Done' : 'failed (reset to New)'}`);
      }
    }
  } else {
    // MODE 3 — manual list from config.topics.manual_topics (the default,
    // no-paid-APIs path). One topic per run.
    log('MODE: manual topics from config');
    const all = ((CFG.topics && CFG.topics.manual_topics) || []).map(String).filter(Boolean);
    const done = loadProcessed();
    const next = all.find((t) => !done.includes(t));
    if (!next) { log(all.length ? 'All manual topics already processed — add more to config.topics.manual_topics.' : 'No manual topics in config — add some to config.topics.manual_topics.'); }
    else {
      const r = await safe('process:manual', () => processTopic(next, 'config manual_topics', voiceCtx), null);
      if (r) { done.push(next); saveProcessed(done); }
      log(`SUMMARY: topic="${next}" ${r ? 'done' : 'failed'} — ${all.length - done.length} topic(s) remaining in the list`);
    }
  }
  log('================ CONTENT WRITER RUN END ==================\n');
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((e) => { logErr('main', e); process.exit(0); });
}
module.exports = { generatePackage, scoreHook, scoredHook, fallbackPackage, anthropicPost, assembleSse, parseLoose };
