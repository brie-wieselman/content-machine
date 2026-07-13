#!/usr/bin/env node
/*
 * dashboard-server.js — tiny local helper so DASHBOARD.html rows open your
 * file manager.
 *
 * Browsers block file:// links from opening a file manager, so instead we
 * serve the dashboard over http://localhost:8765 and give it two endpoints:
 *   GET /reveal?p=<abs>   → reveal + highlight a FILE  (macOS: `open -R`)
 *   GET /open?p=<abs>     → open a FOLDER              (macOS: `open`)
 * The dashboard's inline script calls these on click when it's being served
 * over http (falls back to the plain file:// link if opened as a raw file).
 *
 * Bound to 127.0.0.1 only. Paths are constrained to under output/ so the
 * endpoint can't be used to open arbitrary files. Keep it alive with your
 * scheduler of choice (launchd/systemd) if you want localhost:8765 always up.
 *
 * Run: node agents/dashboard-server.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const { OUT } = require('./common');
const ALLOWED_ROOT = OUT.root;                          // output/
const DASH = path.join(OUT.root, 'DASHBOARD.html');
const PORT = Number(process.env.DASHBOARD_PORT || 8765);

const server = http.createServer((req, res) => {
  let u;
  try { u = new URL(req.url, 'http://localhost'); } catch (_) { res.writeHead(400); return res.end('bad url'); }

  if (u.pathname === '/' || u.pathname === '/DASHBOARD.html') {
    try { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(fs.readFileSync(DASH)); }
    catch (_) { res.writeHead(503); return res.end('Dashboard not built yet — run: node agents/pending-dashboard.js'); }
  }

  if (u.pathname === '/reveal' || u.pathname === '/open') {
    if (process.platform !== 'darwin') { res.writeHead(501); return res.end('reveal/open is macOS-only for now'); }
    const raw = u.searchParams.get('p') || '';
    const abs = path.resolve(raw);
    if (!abs.startsWith(ALLOWED_ROOT + path.sep) && abs !== ALLOWED_ROOT) { res.writeHead(403); return res.end('outside allowed root'); }
    if (!fs.existsSync(abs)) { res.writeHead(404); return res.end('not found'); }
    const args = u.pathname === '/open' ? [abs] : ['-R', abs];   // -R reveals a file; plain open opens a folder
    execFile('open', args, () => {});
    res.writeHead(204); return res.end();
  }

  res.writeHead(404); res.end('not found');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') { console.log(`port ${PORT} already serving — exiting cleanly`); process.exit(0); }
  console.error('dashboard-server error:', e.message); process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => console.log(`dashboard helper live → http://localhost:${PORT}`));
