#!/usr/bin/env node
/* ============================================================================
 * AGENT 3C — CANVA ASSET CREATOR
 *
 * For each of today's content packages in output/pending/, produce a
 * structured Canva brief JSON (canva_brief_<POST-ID>.json) plus a human
 * handoff .md, so the visual can be built from YOUR OWN saved Canva brand
 * templates.
 *
 * Two build paths:
 *   1. HANDOFF (default) — write the brief; the headless /canva-produce step
 *      (agents/run-canva-produce.sh) or you in the Canva editor builds the
 *      visual. Approve the finished asset by replying
 *      CANVA-APPROVED-<POST-ID> <asset-url> to the review email.
 *   2. CONNECT API (optional) — if CANVA_API_TOKEN is set in .env (Canva
 *      Enterprise), autofill + export the PNG directly via the Connect API.
 *
 * Everything brand-specific comes from config:
 *   - template IDs:    config.visual.canva_templates  (YOUR saved templates)
 *   - style guidance:  config.visual.brand_visual_guide_file
 *   - CTA link:        config.brand.website (optional)
 *   - account IDs:     config.scheduler.blotato_account_ids
 *
 * This agent NEVER publishes anything — it only writes briefs and assets.
 * Log and continue, never crash.
 *
 * Run:  node agents/agent3c-canva.js [--dry-run] [--config <path>]
 * ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const { ROOT, OUT, ensureOutputDirs, envReader, configPath, loadConfig, makeLogger, todayLocal } = require('./common');

const log = makeLogger('canva');
const CFG = loadConfig();
const CONFIG_PATH = configPath();
const env = envReader();
const CANVA_TOKEN = env('CANVA_API_TOKEN'); // optional — Connect API path only

ensureOutputDirs();
const CANVA_DIR = path.join(OUT.pending, 'canva');
const BRIEFS_DIR = path.join(CANVA_DIR, 'briefs');
[CANVA_DIR, BRIEFS_DIR].forEach((d) => fs.mkdirSync(d, { recursive: true }));

const today = todayLocal;
const slugify = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);

// ---- template routing ----
// Maps topic text to a content-type key in config.visual.canva_templates.
// Keys are yours to define; the three below match config.example.json. Add a
// route when you add a template. Example niche: an urban-gardening brand might
// route "5 signs your tomatoes need repotting" → listicle.
const ROUTES = [
  { type: 'listicle', match: /\blist(?:icle)?\b|numbered|\d+\s+(?:things|ways|signs|tips|steps|mistakes|reasons)\b/i },
  { type: 'single_stat', match: /\b(?:stat|statistic|number|percent|%|data point|study|research|survey)\b/i },
  { type: 'quote_card', match: /\b(?:quote|story|lesson|personal|essay|myth|truth|belief)\b/i },
];
function configuredTemplates() {
  const t = (CFG.visual && CFG.visual.canva_templates) || {};
  const out = {};
  for (const [k, v] of Object.entries(t)) {
    if (!k.startsWith('_') && v && !/^YOUR_/i.test(v)) out[k] = v;
  }
  return out;
}
function routeFor(text) {
  const templates = configuredTemplates();
  const keys = Object.keys(templates);
  if (!keys.length) return null;
  const hit = ROUTES.find((r) => templates[r.type] && r.match.test(text));
  const type = hit ? hit.type : keys[0]; // fallback: first configured template
  return { type, templateId: templates[type] };
}

// ---- style guidance (replaces any hardcoded colors/fonts) ----
// The brief carries an excerpt of YOUR visual guide so whoever/whatever builds
// the design (the /canva-produce skill, or you) works from your rules.
function styleGuide() {
  const rel = (CFG.visual && CFG.visual.brand_visual_guide_file) || 'config/brand-visual-guide.md';
  try { return fs.readFileSync(path.resolve(ROOT, rel), 'utf8').trim().slice(0, 2000); }
  catch (_) { return '(no brand-visual-guide file found — create the file named in config.visual.brand_visual_guide_file)'; }
}

// ---- platform detection ----
function detectPlatform(pkg) {
  const txt = (pkg.txt || '').toLowerCase();
  if (/carousel|swipe/i.test(txt)) return { platform: 'instagram', dims: '1080x1080', postType: 'carousel' };
  if (/4:5|vertical|1080x1350/i.test(txt)) return { platform: 'instagram', dims: '1080x1350', postType: 'static' };
  if (/linkedin/i.test(txt)) return { platform: 'linkedin', dims: '1200x627', postType: 'static' };
  if (/threads/i.test(txt)) return { platform: 'threads', dims: '1080x1080', postType: 'static' };
  return { platform: 'instagram', dims: '1080x1080', postType: 'static' };
}
function accountIdFor(platform) {
  const ids = (CFG.scheduler && CFG.scheduler.blotato_account_ids) || {};
  const v = ids[platform];
  return v && !/^YOUR_/i.test(String(v)) ? String(v) : '';
}

// ---- package parsing ----
function todaysPackages() {
  try {
    return fs.readdirSync(OUT.pending)
      .filter((f) => f.endsWith('.md') && f.includes(today()))
      .map((f) => path.join(OUT.pending, f))
      .filter((p) => fs.statSync(p).isFile());
  } catch (_) { return []; }
}
function parsePkg(p) {
  const txt = fs.readFileSync(p, 'utf8');
  const topic = (txt.match(/^#\s*(.+)$/m) || [, path.basename(p, '.md')])[1].trim().slice(0, 120);
  const hook = (txt.match(/hook[:*"\s]+(.+)/i) || [, ''])[1].replace(/["*]/g, '').trim();
  const keyPoint = (txt.match(/key point[:*\s]+(.+)/i) || txt.match(/##\s*key point[\s\S]{0,10}\n(.+)/i) || [, ''])[1];
  const visualRef = (txt.match(/VISUAL REFERENCE[:*\s]+(.+)/i) || [, ''])[1];
  const slideSections = [];
  for (const sm of txt.matchAll(/(?:slide|card)\s*(\d+)[:\s]*\n?\s*(.+?)(?=\n(?:slide|card)\s*\d|$)/gi)) {
    slideSections.push({ n: parseInt(sm[1], 10), text: sm[2].trim() });
  }
  return { file: p, txt, topic, hook, keyPoint, visualRef, slideSections };
}

// ---- build Canva brief JSON ----
function buildBrief(pkg, route, editNotes) {
  const postId = `${today()}-${slugify(pkg.topic)}`;
  const pf = detectPlatform(pkg);
  const cta = (CFG.brand && CFG.brand.website) || '';
  const slides = [];
  if (pf.postType === 'carousel' && pkg.slideSections.length) {
    pkg.slideSections.forEach((s) => slides.push({
      slideNumber: s.n,
      headline: s.text.split('\n')[0].slice(0, 80),
      body: s.text.split('\n').slice(1).join(' ').trim().slice(0, 300),
      cta: '',
    }));
    if (slides.length) slides[slides.length - 1].cta = cta;
  } else {
    slides.push({ slideNumber: 1, headline: pkg.hook || pkg.topic, body: (pkg.keyPoint || '').slice(0, 300), cta });
  }
  return {
    postId,
    platform: pf.platform,
    dimensions: pf.dims,
    templateType: route ? route.type : '',
    templateId: route ? route.templateId : '',
    slideCount: slides.length,
    slides,
    styleGuide: styleGuide(),
    accountId: accountIdFor(pf.platform),
    postType: pf.postType,
    editNotes: editNotes || '',
  };
}

// ---- write brief + handoff ----
async function processPkg(pkg, editNotes) {
  const route = routeFor(pkg.txt);
  if (!route) log('WARNING: no Canva templates configured in config.visual.canva_templates — brief will carry an empty templateId.');
  const brief = buildBrief(pkg, route, editNotes);
  const suffix = editNotes ? `_edit${Date.now().toString(36)}` : '';
  const briefPath = path.join(BRIEFS_DIR, `canva_brief_${brief.postId}${suffix}.json`);
  fs.writeFileSync(briefPath, JSON.stringify(brief, null, 2));
  log(`BRIEF written: ${briefPath}`);

  const handoff = path.join(BRIEFS_DIR, `${brief.postId}-CANVA-HANDOFF.md`);
  fs.writeFileSync(handoff, `# Canva build handoff — ${pkg.topic}
Date: ${today()} · Template type: ${brief.templateType || '(none configured)'} · Platform: ${brief.platform}
Brief JSON: ${briefPath}

## AUTO-BUILD (recommended)
Run agents/run-canva-produce.sh (or /canva-produce in Claude Code). It will:
  1. Open your saved brand template (config.visual.canva_templates.${brief.templateType || '<type>'})
  2. Create the design + fill headline/body text
  3. Export PNG to output/pending/canva/
  4. Give you a Canva edit link for manual polish

## MANUAL BUILD
Open the template in Canva, fill the fields below, export PNG, save to
output/pending/canva/${brief.postId}-slide-1.png, then reply to the review email:
  CANVA-APPROVED-${brief.postId} <asset-url>

HEADLINE: ${pkg.hook || pkg.topic}
BODY: ${(pkg.keyPoint || '').slice(0, 300)}
${pkg.visualRef ? `VISUAL REFERENCE: ${pkg.visualRef}` : ''}
Style: see ${(CFG.visual && CFG.visual.brand_visual_guide_file) || 'config/brand-visual-guide.md'}
Dimensions: ${brief.dimensions} · Slides: ${brief.slideCount}
`);
  log(`Canva brief written for ${brief.postId} — visual is built by the canva-produce step and attached to the review email.`);
  return { brief, briefPath };
}

// ---- Canva Connect API path (optional — needs CANVA_API_TOKEN in .env) ----
async function canvaApi(pathname, opts = {}) {
  const res = await fetch(`https://api.canva.com/rest${pathname}`, {
    ...opts, headers: { Authorization: `Bearer ${CANVA_TOKEN}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (!res.ok) throw new Error(`Canva ${pathname} HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}
async function buildViaApi(pkg, route) {
  if (!CANVA_TOKEN) throw new Error('no CANVA_API_TOKEN in .env');
  if (!route) throw new Error('no Canva templates configured');
  const ds = await canvaApi(`/v1/brand-templates/${route.templateId}/dataset`);
  const fields = Object.keys(ds.dataset || {});
  if (!fields.length) throw new Error(`template ${route.templateId} has no autofill dataset fields`);
  const data = {};
  fields.forEach((f, i) => { data[f] = { type: 'text', text: i === 0 ? (pkg.hook || pkg.topic) : (pkg.keyPoint || pkg.topic) }; });
  const job = await canvaApi('/v1/autofills', { method: 'POST', body: JSON.stringify({ brand_template_id: route.templateId, data }) });
  let design = null;
  for (let i = 0; i < 30 && !design; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const s = await canvaApi(`/v1/autofills/${job.job.id}`);
    if (s.job.status === 'success') design = s.job.result.design;
    if (s.job.status === 'failed') throw new Error('autofill failed');
  }
  if (!design) throw new Error('autofill timed out');
  const exp = await canvaApi('/v1/exports', { method: 'POST', body: JSON.stringify({ design_id: design.id, format: { type: 'png' } }) });
  let urls = [];
  for (let i = 0; i < 30 && !urls.length; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const s = await canvaApi(`/v1/exports/${exp.job.id}`);
    if (s.job.status === 'success') urls = s.job.urls || [];
    if (s.job.status === 'failed') throw new Error('export failed');
  }
  const out = path.join(CANVA_DIR, `${today()}-${slugify(pkg.topic)}-feed.png`);
  fs.writeFileSync(out, Buffer.from(await (await fetch(urls[0])).arrayBuffer()));
  log(`  Canva export saved: ${out} (template ${route.templateId})`);
  return out;
}

// ---- main ----
async function main() {
  log('================ CANVA RUN START ================');
  log(`config: ${CONFIG_PATH}`);
  const dryRun = process.argv.includes('--dry-run');
  const pkgs = todaysPackages();
  if (!pkgs.length) { log('No packages today — nothing to design.'); log('================ CANVA RUN END ================\n'); return; }
  for (const p of pkgs) {
    const pkg = parsePkg(p);
    const route = routeFor(pkg.txt);
    log(`PACKAGE "${pkg.topic}" → ${route ? route.type : '(no template configured)'}`);
    try {
      if (dryRun) {
        console.log('\n--- DRY RUN: Canva brief JSON ---');
        console.log(JSON.stringify(buildBrief(pkg, route, ''), null, 2));
        console.log('--- END DRY RUN ---\n');
      } else {
        await processPkg(pkg);
      }
    } catch (e) { log.err(`pkg:${pkg.topic}`, e); }
  }
  log('================ CANVA RUN END ================\n');
}
if (require.main === module) main().then(() => process.exit(0)).catch((e) => { log(`FATAL: ${e.message}`); process.exit(0); });
module.exports = { routeFor, buildBrief, processPkg, parsePkg, buildViaApi };
