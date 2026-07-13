#!/usr/bin/env node
'use strict';
/**
 * aeo-weekly.js — long-form article writer (weekly lane).
 *
 * Picks the next N topics from config.topics.manual_topics (skipping ones it
 * has already written), generates each as an answer-engine-optimized (AEO)
 * article — question H1, direct answer up top, question-led sections, FAQ —
 * in YOUR voice (config.voice.fingerprint_file + content_rules_file), grades
 * each draft against the voice spec, rewrites once if it scores below 7/10,
 * and writes the finished article to config.articles.output_dir as BOTH
 * markdown and standalone HTML.
 *
 * Files-only by design: no website integration, no publish endpoint. You take
 * the files and publish them wherever you like (blog, newsletter, CMS).
 *
 *   node agents/aeo-weekly.js --files-only [--config config/config.json]
 *                             [--count 2] [--topic "One-off topic question"]
 *
 * State: output/articles/state/written.json remembers which topics are done,
 * so the weekly run walks your topic list without repeating itself.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ---------------------------------------------------------------------------
// Paths + CLI
// ---------------------------------------------------------------------------
const ROOT = path.resolve(__dirname, '..');
function cliArg(flag, dflt) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const CONFIG_PATH = path.resolve(ROOT, cliArg('--config', 'config/config.json'));
const COUNT = Number(cliArg('--count', '1')) || 1;
const TOPIC_OVERRIDE = cliArg('--topic', '');
const TODAY = new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Config + env
// ---------------------------------------------------------------------------
function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`Missing config at ${CONFIG_PATH} — copy config/config.example.json to config/config.json and fill it in.`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}
const CFG = loadConfig();

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
const ANTHROPIC_KEY = (process.env.ANTHROPIC_API_KEY || ENV.ANTHROPIC_API_KEY || '').trim();
const MODEL = (process.env.ANTHROPIC_MODEL || ENV.ANTHROPIC_MODEL || 'claude-sonnet-5').trim();

if (!ANTHROPIC_KEY || /^your-/.test(ANTHROPIC_KEY)) {
  console.error('Missing ANTHROPIC_API_KEY — add it to .env at the repo root (see .env.example).');
  process.exit(1);
}

const OUT_DIR = path.resolve(ROOT, (CFG.articles && CFG.articles.output_dir) || 'output/articles');
const STATE_DIR = path.join(OUT_DIR, 'state');
fs.mkdirSync(STATE_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Anthropic transport via curl, STREAMING.
// WHY curl + streaming (both learned in production, keep them):
//  - Node's global fetch (undici) can reuse dead keep-alive sockets after a
//    machine wakes from sleep — a single call hangs for 30+ minutes and then
//    throws an opaque "fetch failed". curl opens a fresh connection each call
//    and fails fast under --max-time, so the retry loop actually works.
//  - Some networks kill any HTTP response that has sent no bytes for ~60s.
//    A long generation sits "idle" that long before the first byte of a
//    non-streaming response. With stream:true the server sends SSE bytes from
//    the first token, so the connection is never idle. The SSE events are
//    reassembled below into the classic message shape ({content, stop_reason}).
// ---------------------------------------------------------------------------
function anthropicPost(body, timeoutSec = 300) {
  const tmp = path.join(require('os').tmpdir(), `anthropic-req-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify({ ...body, stream: true }));
  try {
    const out = execSync(
      `curl -sS -N --http1.1 --max-time ${timeoutSec} -w '\\n===HTTP_STATUS===%{http_code}' ` +
      `-X POST https://api.anthropic.com/v1/messages ` +
      `-H "x-api-key: $ANTHROPIC_KEY" -H "anthropic-version: 2023-06-01" ` +
      `-H "content-type: application/json" --data-binary @${tmp}`,
      { encoding: 'utf8', timeout: (timeoutSec + 15) * 1000, maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, ANTHROPIC_KEY } }
    );
    const statusM = out.match(/===HTTP_STATUS===(\d+)\s*$/);
    const status = statusM ? Number(statusM[1]) : 0;
    const payload = out.replace(/\n?===HTTP_STATUS===\d+\s*$/, '');
    if (status < 200 || status >= 300) {
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
  for (const line of sse.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    let ev; try { ev = JSON.parse(line.slice(5).trim()); } catch (_) { continue; }
    if (ev.type === 'message_start' && ev.message) { msg.usage = ev.message.usage || {}; }
    else if (ev.type === 'content_block_start') {
      msg.content[ev.index] = { ...ev.content_block };
      if (ev.content_block.type === 'text' && msg.content[ev.index].text === undefined) msg.content[ev.index].text = '';
    } else if (ev.type === 'content_block_delta') {
      const blk = msg.content[ev.index]; if (!blk) continue;
      if (ev.delta.type === 'text_delta') blk.text = (blk.text || '') + ev.delta.text;
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

// Retry the model call — transient network failures shouldn't lose the run.
function callModel(system, user, maxTokens, attempts = 3) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      const r = anthropicPost({ model: MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }, 240);
      if (r.ok) return (r.json.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
      lastErr = new Error('anthropic ' + r.status + ': ' + JSON.stringify(r.json).slice(0, 200));
      if (r.status && r.status < 500 && r.status !== 429) throw lastErr; // 4xx (except rate limit) won't fix on retry
    } catch (e) { lastErr = e; }
    if (i < attempts) { console.log(`  model call attempt ${i} failed (${lastErr.message.slice(0, 80)}) — retrying in 20s`); try { execSync('sleep 20'); } catch (_) {} }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Voice — fingerprint + content rules, both plug-in files named in config.
// buildBrandContext extracts the content-rules doc BY HEADING (never by
// character-slicing — see the drift story in agents/brand-context.js).
// ---------------------------------------------------------------------------
function readCfgFile(rel) {
  if (!rel) return '';
  try { return fs.readFileSync(path.resolve(ROOT, rel), 'utf8'); } catch { return ''; }
}
function loadVoice() {
  return readCfgFile(CFG.voice && CFG.voice.fingerprint_file);
}
function loadBrand() {
  const bc = require('./brand-context');
  const contentDoc = readCfgFile(CFG.voice && CFG.voice.content_rules_file);
  return bc.buildBrandContext({ voice: loadVoice(), hooks: '', contentDoc });
}

// ---------------------------------------------------------------------------
// Topic picking — walk config.topics.manual_topics, skipping done ones
// ---------------------------------------------------------------------------
function loadWritten() {
  try { return JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'written.json'), 'utf8')); } catch { return []; }
}
function saveWritten(list) {
  fs.writeFileSync(path.join(STATE_DIR, 'written.json'), JSON.stringify(list, null, 2));
}
function nextTopics(n) {
  if (TOPIC_OVERRIDE) return [TOPIC_OVERRIDE];
  const all = (CFG.topics && CFG.topics.manual_topics) || [];
  const done = new Set(loadWritten().map((w) => w.topic));
  return all.filter((t) => !done.has(t)).slice(0, n);
}

function slugify(s) {
  return s.toLowerCase().replace(/['']/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}

// ---------------------------------------------------------------------------
// The article template — answer-engine-optimized long form:
// question H1, direct answer first (what AI Overviews lift verbatim),
// question-led sections, a FAQ of adjacent questions. Generic by design;
// YOUR voice comes from the fingerprint + content rules in the system prompt.
// ---------------------------------------------------------------------------
const TEMPLATE_RULES = `Write a single long-form article for the brand described above. Output EXACTLY in this structure, nothing before or after:

\`\`\`json
{"slug":"plain-language-question-slug","meta_description":"150-160 char summary that contains the key answer"}
\`\`\`

# [The topic phrased as the exact question a real reader would type into a search box]

**DIRECT ANSWER**
[40-60 words. Answer the H1 completely and self-containedly — this is the part answer engines quote verbatim.]

**WHO THIS IS FOR**
[1-2 sentences naming the reader's exact situation.]

## [Question-led heading: why/how this happens]
[Clear explanation of the underlying mechanism, in the brand voice. Self-contained.]

## [Question-led heading: what this looks like in practice]
[- bulleted, scannable list of concrete scenarios or signs]

## [Question-led heading: what actually helps]
[Specific, actionable guidance. Concrete steps over vague advice. If the brand offers a relevant product or service, name it plainly and state its limits in the same breath — never overclaim.]

## [Question-led heading: when to get more help]
[One paragraph — when self-serve isn't enough and it's time to bring in a professional. Builds trust without overpromising.]

## FAQ
**[Adjacent question 1?]**
[Short self-contained answer.]

**[Adjacent question 2?]**
[Short self-contained answer.]

**[Adjacent question 3?]**
[Short self-contained answer.]

RULES: plain language a layperson can follow; every section self-contained (readers and answer engines land mid-page); no exclamation points; respect every banned word and voice rule in the brand context above; do not add a byline or related-links section.`;

function generateArticle(topic, brand) {
  const system = brand + '\n\n---\n\n' + TEMPLATE_RULES;
  const user = `Article to write:\n"${topic}"\n\nWrite the full article now, in the exact structure specified.`;
  return callModel(system, user, 3000);
}

// Grade against the voice spec; the pipeline pattern is: grade -> if below
// threshold, one revision pass with the grader's feedback -> re-grade.
function gradeArticle(md) {
  const voice = loadVoice();
  const system = `You are a strict brand-voice grader. Grade the article against this voice spec:\n\n${voice.slice(0, 6000)}\n\nRubric (score /10): clarity & self-contained answer-engine value (40%), brand-voice fit — banned words respected, sentence rhythm matches the spec, no generic-AI filler (30%), credibility & honesty — concrete, no overclaiming (30%). Output ONLY:\nScore: N/10\nTop 3 fixes:\n- ...\n- ...\n- ...`;
  const out = callModel(system, 'Grade this article:\n\n' + md, 700);
  const score = Number((out.match(/Score:\s*(\d+(?:\.\d+)?)\s*\/\s*10/i) || [])[1] || 0);
  return { score, feedback: out };
}

// ---------------------------------------------------------------------------
// Parse + render
// ---------------------------------------------------------------------------
function parseArticle(md) {
  const jsonM = md.match(/```json\s*([\s\S]*?)```/);
  let meta = {};
  try { meta = JSON.parse(jsonM ? jsonM[1] : '{}'); } catch {}
  const body = md.replace(/```json[\s\S]*?```/, '').trim();
  const title = (body.match(/^#\s+(.+)$/m) || [])[1];
  return { meta, title: title ? title.trim() : '', body };
}

// Minimal markdown -> HTML (headings, bold, lists, paragraphs). Deliberately
// small: the output is a starting point you can paste into any CMS.
function mdToHtml(md, title, metaDescription) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (s) => esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2">$1</a>');
  const out = [];
  let inList = false;
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const li = line.match(/^\s*[-*]\s+(.+)$/);
    if (li) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`  <li>${inline(li[1])}</li>`);
      continue;
    }
    if (inList) { out.push('</ul>'); inList = false; }
    const h = line.match(/^(#{1,4})\s+(.+)$/);
    if (h) { const n = h[1].length; out.push(`<h${n}>${inline(h[2])}</h${n}>`); continue; }
    if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (inList) out.push('</ul>');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="${esc(metaDescription || '')}">
<title>${esc(title || 'Article')}</title>
<style>body{max-width:44rem;margin:2rem auto;padding:0 1rem;font-family:Georgia,serif;line-height:1.6;color:#222}h1,h2,h3{font-family:Helvetica,Arial,sans-serif;line-height:1.25}</style>
</head>
<body>
${out.join('\n')}
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
function run() {
  const brand = loadBrand();
  if (!brand.trim()) {
    console.error('No voice/content files found — set config.voice.fingerprint_file and content_rules_file (see config/README.md). Writing without them produces generic-AI voice.');
    process.exit(1);
  }
  const topics = nextTopics(COUNT);
  if (!topics.length) {
    console.log('No unwritten topics left in config.topics.manual_topics — add more, or pass --topic "Your question".');
    return;
  }
  console.log(`Model: ${MODEL} | topics: ${topics.length} | output: ${OUT_DIR}`);

  const written = loadWritten();
  for (const topic of topics) {
    console.log(`\n--- ${topic} ---`);
    let md = generateArticle(topic, brand);
    let g = gradeArticle(md);
    console.log('  grade:', g.score + '/10');
    if (g.score < 7) {
      console.log('  below 7 — one revision pass');
      md = callModel(brand + '\n\n' + TEMPLATE_RULES,
        `Revise this article to fix these issues, keeping the exact structure:\n\n${g.feedback}\n\n=== ARTICLE ===\n${md}`, 3000);
      g = gradeArticle(md);
      console.log('  re-grade:', g.score + '/10');
    }
    const p = parseArticle(md);
    const slug = (p.meta.slug && /^[a-z0-9-]+$/.test(p.meta.slug)) ? p.meta.slug : slugify(p.title || topic);
    const mdFile = path.join(OUT_DIR, `${TODAY}-${slug}.md`);
    const htmlFile = path.join(OUT_DIR, `${TODAY}-${slug}.html`);
    fs.writeFileSync(mdFile, md);
    fs.writeFileSync(htmlFile, mdToHtml(p.body, p.title, p.meta.meta_description));
    console.log(`  wrote ${path.relative(ROOT, mdFile)}`);
    console.log(`  wrote ${path.relative(ROOT, htmlFile)}`);
    written.push({ topic, slug, date: TODAY, grade: g.score });
    saveWritten(written);
  }
  console.log(`\nDone — ${topics.length} article(s) in ${OUT_DIR}. Publish them wherever you like.`);
}

try {
  run();
} catch (e) {
  console.error('Article run failed:', e && e.message);
  process.exit(1);
}
