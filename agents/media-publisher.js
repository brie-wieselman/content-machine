/* ============================================================================
 * media-publisher.js — host a local file (or rehost a public URL) on the
 * scheduler backend's CDN and return a stable public URL.
 *
 * Why: multi-platform scheduling needs a PUBLIC https URL for every image or
 * video. Blotato's POST /v2/media accepts either a public URL or a base64
 * data URI and returns its own CDN URL — one stop for all downstream
 * scheduling, with no third-party hosting and no extra keys.
 *
 * Cron-safe: no MCPs, no CLIs — just SCHEDULER_API_KEY from .env.
 * Idempotent: results are cached by content hash, so re-runs don't re-upload.
 *
 * Run:  node agents/media-publisher.js <local-file-or-url> [--config <path>]
 *       (--config is accepted for CLI symmetry; this module needs no config)
 * ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { LOG_DIR, envReader, makeLogger } = require('./common');

const log = makeLogger('media-publisher');
const env = envReader();
const KEY = env('SCHEDULER_API_KEY');

// Blotato CDN accepts up to ~200MB. Keep a generous ceiling.
const MAX = 200 * 1024 * 1024;
const CACHE_FILE = path.join(LOG_DIR, 'media-publisher-cache.json');
function cacheRead() { try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch (_) { return {}; } }
function cacheWrite(c) { try { fs.writeFileSync(CACHE_FILE, JSON.stringify(c, null, 2)); } catch (e) { log(`cache write failed: ${e.message}`); } }
function sha(file) { return execSync(`shasum -a 1 "${file}"`, { encoding: 'utf8' }).split(' ')[0]; }

const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/mp4' };
function mimeFor(file) { return MIME[path.extname(file).slice(1).toLowerCase()] || 'application/octet-stream'; }

async function cdnIngest(payload) {
  const res = await fetch('https://backend.blotato.com/v2/media', {
    method: 'POST', headers: { 'blotato-api-key': KEY, 'content-type': 'application/json' }, body: JSON.stringify({ url: payload }),
  });
  if (!res.ok) throw new Error(`Blotato /v2/media HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  if (!j.url) throw new Error(`Blotato /v2/media missing url in response: ${JSON.stringify(j).slice(0, 200)}`);
  return j.url;
}

/** Publish a local file → public URL. Returns { url } or null. Idempotent via cache. */
async function publish(localPath) {
  try {
    if (!KEY) throw new Error('no SCHEDULER_API_KEY in .env');
    if (!fs.existsSync(localPath)) throw new Error(`file not found: ${localPath}`);
    const stat = fs.statSync(localPath);
    if (stat.size > MAX) throw new Error(`file too large (${Math.round(stat.size / 1024 / 1024)}MB > 200MB)`);
    const digest = sha(localPath);
    const cache = cacheRead();
    if (cache[digest]) { log(`cached → ${cache[digest]}`); return { url: cache[digest], cached: true }; }
    // The media endpoint only accepts JSON (URL or base64 data URI) — multipart
    // is rejected with 415. For large videos, compress with ffmpeg first so the
    // base64 payload stays under the ~15MB JSON ceiling.
    const mime = mimeFor(localPath);
    let uploadPath = localPath;
    let tmpCompressed = null;
    if (mime.startsWith('video/') && stat.size > 10 * 1024 * 1024) {
      tmpCompressed = localPath.replace(/(\.\w+)$/, '-upload-tmp$1');
      log(`Video ${Math.round(stat.size / 1024 / 1024)}MB — compressing for upload…`);
      execSync(
        `ffmpeg -y -i "${localPath}" -vcodec libx264 -crf 28 -preset fast -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2" -acodec aac -b:a 128k "${tmpCompressed}"`,
        { timeout: 180000 }
      );
      uploadPath = tmpCompressed;
      log(`Compressed → ${Math.round(fs.statSync(tmpCompressed).size / 1024)}KB`);
    }
    let url;
    try {
      const dataUri = `data:${mime};base64,${fs.readFileSync(uploadPath).toString('base64')}`;
      url = await cdnIngest(dataUri);
    } finally {
      if (tmpCompressed && fs.existsSync(tmpCompressed)) fs.unlinkSync(tmpCompressed);
    }
    cache[digest] = url; cacheWrite(cache);
    log(`PUBLISHED ${path.basename(localPath)} (${Math.round(stat.size / 1024)}KB) → ${url}`);
    return { url };
  } catch (e) { log(`PUBLISH FAILED ${localPath}: ${e.message}`); return null; }
}

/** Rehost a remote URL → CDN URL (so the scheduler backend owns the asset). */
async function rehost(publicUrl) {
  try {
    if (!KEY) throw new Error('no SCHEDULER_API_KEY in .env');
    const cache = cacheRead();
    if (cache[publicUrl]) return { url: cache[publicUrl], cached: true };
    const url = await cdnIngest(publicUrl);
    cache[publicUrl] = url; cacheWrite(cache);
    log(`REHOSTED ${publicUrl} → ${url}`);
    return { url };
  } catch (e) { log(`REHOST FAILED ${publicUrl}: ${e.message}`); return null; }
}

module.exports = { publish, rehost };

if (require.main === module) {
  (async () => {
    // First positional arg that isn't a flag or a flag's value.
    const args = process.argv.slice(2);
    let target = '';
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--config') { i++; continue; }
      if (!args[i].startsWith('--')) { target = args[i]; break; }
    }
    if (!target) { console.error('Usage: node agents/media-publisher.js <local-file-or-url>'); process.exit(1); }
    const r = target.startsWith('http') ? await rehost(target) : await publish(path.resolve(target));
    if (!r) process.exit(2);
    console.log(JSON.stringify(r, null, 2));
  })();
}
