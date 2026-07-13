#!/usr/bin/env node
/*
 * pending-dashboard.js — builds output/DASHBOARD.html
 *
 * Your single human view of the content engine's output. Scans the output/
 * folders and presents everything in plain-English sections:
 *   pending    engine proposed it — your yes/no
 *   articles   finished long-form — you publish it wherever you like
 *   approved   your recent yeses (queued/scheduled from here)
 *   rejected   your recent nos (kept for reference, never deleted)
 *   machine    specs, flags, grades — ignore unless curious
 *
 * DESIGN RULE (learned the hard way): this script is READ-ONLY. It NEVER
 * moves or deletes. Anything loose in output/ that isn't recognized machine
 * I/O is shown in a bright "⚠ UNSORTED" band so a stray file is always
 * VISIBLE, never silently swept into an ignore-folder. Filing is a human
 * decision, not something this generator guesses at.
 *
 * Run standalone:  node agents/pending-dashboard.js [--config <path>]
 * Wired as the final step of pipeline.js so the view is always fresh.
 * Serve it over localhost (see dashboard-server.js) to get click-to-reveal.
 */
const fs = require('fs');
const path = require('path');

const { OUT, ensureOutputDirs } = require('./common');
ensureOutputDirs();
const OUTFILE = path.join(OUT.root, 'DASHBOARD.html');

const BUCKETS = [
  { dir: OUT.pending,  key: 'pending',  label: 'Approve these', note: 'The engine proposed these. Your yes / no.', accent: '#e08a2b', emoji: '⭐' },
  { dir: OUT.articles, key: 'articles', label: 'Articles',      note: 'Finished long-form. Publish wherever you like.', accent: '#2e9e6b', emoji: '📝' },
  { dir: OUT.approved, key: 'approved', label: 'Approved',      note: 'Your recent yeses — queued or scheduled.', accent: '#3b82c4', emoji: '✅' },
  { dir: OUT.rejected, key: 'rejected', label: 'Rejected',      note: 'Your recent nos. Kept for reference.', accent: '#8a8f98', emoji: '🗑' },
  { dir: OUT.queue,    key: 'machine',  label: 'Machine queue', note: 'Pipeline I/O. Ignore unless curious.', accent: '#8a8f98', emoji: '📁' },
];

// Files that are the meta layer itself — never listed as content.
const META = new Set(['DASHBOARD.html', 'README.md', '.DS_Store']);
// Machine scratch the pipeline writes loose and re-reads by pattern. We SHOW
// these under "machine" but must never move them.
const isMachineLoose = (n) => /_spec_.*\.json$/i.test(n) || /\.flag\.txt$/i.test(n) || /\.done$/i.test(n) || /^canva_.*\.json$/i.test(n) || /\.grade\.txt$/i.test(n);

function human(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}
function ymd(mtime) { try { return mtime.toISOString().slice(0, 10); } catch (_) { return ''; } }

// Pull a one-line human description out of a markdown file (first # heading,
// or the first meaningful non-frontmatter line).
function describeMd(p) {
  try {
    const lines = fs.readFileSync(p, 'utf8').split('\n').slice(0, 80);
    let inFm = false;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i].trim();
      if (i === 0 && l === '---') { inFm = true; continue; }
      if (inFm) { if (l === '---') inFm = false; continue; }
      const h = l.match(/^#{1,3}\s+(.+)/);
      if (h) return h[1].replace(/[*_`]/g, '').slice(0, 120);
    }
    for (const l of lines) { const t = l.trim(); if (t && !t.startsWith('#') && !t.startsWith('>')) return t.replace(/[*_`]/g, '').slice(0, 120); }
  } catch (_) {}
  return '';
}
function describeFolder(p) {
  try {
    const kids = fs.readdirSync(p).filter((k) => !k.startsWith('.'));
    for (const rm of ['README.md', 'README.txt']) {
      if (kids.includes(rm)) { const d = describeMd(path.join(p, rm)); if (d) return d; }
    }
    const n = kids.length;
    const preview = kids.slice(0, 4).join(', ');
    return `${n} item${n === 1 ? '' : 's'}${preview ? ' — ' + preview + (n > 4 ? '…' : '') : ''}`;
  } catch (_) { return ''; }
}
function describe(p, isDir, name) {
  if (isDir) return describeFolder(p);
  if (/\.md$/i.test(name)) return describeMd(p);
  if (/\.pdf$/i.test(name)) return 'PDF document';
  if (/\.html?$/i.test(name)) return 'HTML page';
  if (/\.json$/i.test(name)) return 'machine spec (JSON)';
  if (/\.(png|jpe?g|webp)$/i.test(name)) return 'image';
  return '';
}

function itemFor(base, name) {
  const p = path.join(base, name);
  let st; try { st = fs.statSync(p); } catch (_) { return null; }
  const isDir = st.isDirectory();
  return { name, isDir, abs: p, date: ymd(st.mtime), size: isDir ? null : st.size, desc: describe(p, isDir, name) };
}
// file:// URL that survives spaces / unicode in the path, so each row links
// straight to the file or folder — no manual navigating.
function fileUrl(abs) { return 'file://' + String(abs).split('/').map(encodeURIComponent).join('/'); }

// ---- collect ----
const sections = { pending: [], articles: [], approved: [], rejected: [], machine: [], unsorted: [] };

// 1) contents of each bucket
for (const b of BUCKETS) {
  if (!fs.existsSync(b.dir)) continue;
  for (const name of fs.readdirSync(b.dir).filter((n) => !n.startsWith('.')).sort()) {
    const it = itemFor(b.dir, name);
    if (it) sections[b.key].push(it);
  }
}

// 2) loose items at the top of output/ (anything not in a known bucket)
const bucketNames = new Set(Object.keys(OUT).map((k) => path.basename(OUT[k])));
for (const name of (fs.existsSync(OUT.root) ? fs.readdirSync(OUT.root) : []).filter((n) => !n.startsWith('.')).sort()) {
  if (META.has(name)) continue;
  if (bucketNames.has(name)) continue;
  const it = itemFor(OUT.root, name);
  if (!it) continue;
  if (isMachineLoose(name)) { it.tag = 'machine'; sections.machine.push(it); continue; }
  // genuinely unrecognized loose file → SHOW IT LOUDLY, never hide
  it.tag = 'new · untriaged';
  sections.unsorted.push(it);
}

// ---- render ----
const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const now = new Date();
const stamp = `${ymd(now)} ${now.toTimeString().slice(0, 5)}`;

function renderItems(items) {
  if (!items.length) return '<p class="empty">Nothing here right now.</p>';
  return items.map((it) => `
    <a class="item" href="${it.abs ? fileUrl(it.abs) : '#'}" data-abs="${it.abs ? esc(it.abs) : ''}" data-dir="${it.isDir ? '1' : '0'}" title="Reveal ${esc(it.name)} in your file manager">
      <div class="ic">${it.isDir ? '📂' : '📄'}</div>
      <div class="body">
        <div class="name">${esc(it.name)}${it.tag ? `<span class="tag">${esc(it.tag)}</span>` : ''}</div>
        ${it.desc ? `<div class="desc">${esc(it.desc)}</div>` : ''}
      </div>
      <div class="meta">${esc(it.date)}${it.size != null ? ' · ' + human(it.size) : ''}</div>
    </a>`).join('');
}

const unsortedBand = sections.unsorted.length ? `
  <section class="band warn">
    <h2>⚠ Unsorted — new &amp; untriaged (${sections.unsorted.length})</h2>
    <p class="bandnote">These landed loose since the last sweep and don't match a known type. They are <strong>new work</strong>, not abandoned — file each one where it belongs.</p>
    ${renderItems(sections.unsorted)}
  </section>` : '';

const cards = BUCKETS.map((b) => {
  const items = sections[b.key];
  return `
  <section class="card" style="--accent:${b.accent}">
    <div class="cardhead">
      <span class="emoji">${b.emoji}</span>
      <div>
        <h2>${b.label} <span class="count">${items.length}</span></h2>
        <p class="note">${b.note}</p>
      </div>
    </div>
    <div class="items">${renderItems(items)}</div>
  </section>`;
}).join('');

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pending Your Review — Dashboard</title>
<style>
  :root { --bg:#faf8f5; --fg:#1c1a17; --muted:#6b6660; --line:#e7e2db; --card:#ffffff; --warnbg:#fff4e5; --warnline:#e0a44a; --accent:#8a8f98; }
  @media (prefers-color-scheme: dark) { :root { --bg:#17150f; --fg:#ece7df; --muted:#9a938a; --line:#2c2820; --card:#1f1c16; --warnbg:#2a2213; --warnline:#7a5a24; } }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
  .wrap { max-width:1080px; margin:0 auto; padding:28px 20px 80px; }
  header h1 { font-size:26px; margin:0 0 4px; letter-spacing:-.01em; }
  header .sub { color:var(--muted); margin:0 0 4px; }
  header .stamp { color:var(--muted); font-size:12.5px; }
  .legend { display:flex; flex-wrap:wrap; gap:10px 18px; margin:18px 0 6px; padding:12px 14px; background:var(--card); border:1px solid var(--line); border-radius:10px; font-size:13px; }
  .legend b { font-weight:600; }
  .band { margin:22px 0; padding:16px 18px; border-radius:12px; }
  .band.warn { background:var(--warnbg); border:1px solid var(--warnline); }
  .band h2 { margin:0 0 4px; font-size:17px; }
  .bandnote { margin:0 0 10px; color:var(--muted); font-size:13.5px; }
  .grid { display:grid; grid-template-columns:1fr 1fr; gap:18px; margin-top:16px; }
  @media (max-width:720px) { .grid { grid-template-columns:1fr; } }
  .card { background:var(--card); border:1px solid var(--line); border-top:3px solid var(--accent); border-radius:12px; padding:16px 16px 8px; }
  .cardhead { display:flex; gap:12px; align-items:flex-start; margin-bottom:10px; }
  .cardhead .emoji { font-size:22px; line-height:1.2; }
  .cardhead h2 { font-size:17px; margin:0; }
  .count { display:inline-block; min-width:22px; text-align:center; font-size:12px; font-weight:700; color:#fff; background:var(--accent); border-radius:20px; padding:1px 8px; margin-left:6px; vertical-align:middle; }
  .note { margin:2px 0 0; color:var(--muted); font-size:13px; }
  .item { display:flex; gap:10px; align-items:flex-start; padding:9px 6px; border-top:1px solid var(--line); text-decoration:none; color:inherit; border-radius:6px; transition:background .1s; }
  .item:hover { background:color-mix(in srgb, var(--accent) 9%, transparent); }
  .item:hover .name { text-decoration:underline; text-decoration-color:var(--accent); text-underline-offset:2px; }
  .item .ic { font-size:15px; opacity:.8; padding-top:1px; }
  .item .body { flex:1; min-width:0; }
  .item .name { font-weight:600; font-size:14px; word-break:break-word; }
  .item .tag { font-size:10.5px; font-weight:700; text-transform:uppercase; letter-spacing:.03em; color:var(--accent); border:1px solid var(--accent); border-radius:5px; padding:0 5px; margin-left:8px; white-space:nowrap; }
  .item .desc { color:var(--muted); font-size:13px; margin-top:2px; word-break:break-word; }
  .item .meta { color:var(--muted); font-size:12px; white-space:nowrap; padding-top:2px; }
  .empty { color:var(--muted); font-size:13px; font-style:italic; padding:8px 4px; margin:0; }
  footer { margin-top:28px; color:var(--muted); font-size:12.5px; border-top:1px solid var(--line); padding-top:14px; }
  code { background:var(--line); padding:1px 5px; border-radius:4px; font-size:12px; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Pending Your Review</h1>
    <p class="sub">Everything the content engine has produced or proposed, in one place. This is your entry point — you shouldn't need to open the raw folders.</p>
    <p class="stamp">Rebuilt ${stamp}</p>
  </header>

  <div class="legend">
    <span>⭐ <b>Approve</b> = say yes/no</span>
    <span>📝 <b>Articles</b> = you publish them</span>
    <span>✅ <b>Approved</b> / 🗑 <b>Rejected</b> = your past calls</span>
    <span>📁 <b>Machine</b> = ignore</span>
    <span>⚠ <b>Unsorted</b> = new, file it somewhere</span>
  </div>

  ${unsortedBand}

  <div class="grid">
    ${cards}
  </div>

  <footer>
    Auto-generated by <code>agents/pending-dashboard.js</code> at the end of every pipeline run.
    Machine plumbing (specs, flags, grades) is left in place so the approval automation keeps working.
    Nothing is ever auto-deleted or hidden; a stray file shows as <b>Unsorted</b>.
  </footer>
</div>
<script>
  // When served by the local helper (dashboard-server.js on localhost),
  // clicking a row reveals it in your file manager via the /reveal (file) or
  // /open (folder) endpoint. When the page is opened as a raw file://, we
  // leave the href alone so it still works (opens the file directly).
  if (location.protocol.startsWith('http')) {
    document.querySelectorAll('a.item[data-abs]').forEach(function (a) {
      a.addEventListener('click', function (e) {
        var abs = a.getAttribute('data-abs'); if (!abs) return;
        e.preventDefault();
        var ep = a.getAttribute('data-dir') === '1' ? '/open?p=' : '/reveal?p=';
        fetch(ep + encodeURIComponent(abs)).catch(function () {});
      });
    });
  }
</script>
</body>
</html>`;

fs.writeFileSync(OUTFILE, html);
const total = Object.values(sections).reduce((a, s) => a + s.length, 0);
console.log(`[pending-dashboard] wrote ${OUTFILE}`);
console.log(`  pending:${sections.pending.length} articles:${sections.articles.length} approved:${sections.approved.length} rejected:${sections.rejected.length} machine:${sections.machine.length} unsorted:${sections.unsorted.length} (total ${total})`);
