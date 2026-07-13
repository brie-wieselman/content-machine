#!/usr/bin/env node
/* ============================================================================
 * janitor.js — keeps output/pending/ free of machine scratch.
 *
 * THE PROBLEM IT SOLVES: the pipeline writes internal working files (canva
 * specs, exported PNGs, grade files) into the SAME folder you review content
 * in. Over time they pile up and bury the few items that actually need your
 * eyes.
 *
 * WHAT IT DOES: moves ONLY pure-machine artifacts that have already been
 * consumed by the pipeline out to output/_working/ (a sibling folder you never
 * have to open). It NEVER touches:
 *   - content packages (*.md)        → these ARE your review queue
 *   - anything newer than its grace window (so same-day workflows still work)
 *   - anything it doesn't explicitly recognize
 *
 * Safe by construction: it relocates by EXPLICIT pattern match only. Anything
 * unrecognized is left exactly where it is. Relocation, never deletion.
 *
 * RUN:      node agents/janitor.js            (dry run: add --dry)
 * SCHEDULE: nightly via your scheduler of choice (cron / launchd)
 * ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const { OUT, ensureOutputDirs } = require('./common');

const PENDING = OUT.pending;
const WORKING = OUT.working;
const DRY = process.argv.includes('--dry');

const DAY = 86400000;
const now = Date.now();
const ageDays = (p) => (now - fs.statSync(p).mtimeMs) / DAY;

// Pipeline-scratch patterns and where each goes. graceDays = leave it in
// pending this long so same-day / next-day pipeline + approval still find it.
const RULES = [
  { test: (n) => /^canva_.*\.(json|done)$/.test(n), dest: 'canva-specs', graceDays: 1 },
  { test: (n) => /\.grade\.txt$/.test(n),           dest: 'grades',      graceDays: 1 },
];
// Working sub-dirs whose CONTENTS get swept (the dir itself stays so agents
// can keep writing to it): exported canva images already consumed by the report.
const SWEEP_DIR_CONTENTS = [
  { dir: 'canva', dest: 'canva-exports', graceDays: 1 },
];

function ensure(d) { if (!DRY) fs.mkdirSync(d, { recursive: true }); }
function move(src, destDir, name) {
  ensure(destDir);
  const target = path.join(destDir, name);
  console.log(`${DRY ? '[dry] ' : ''}move: ${name} → output/_working/${path.relative(WORKING, destDir)}/`);
  if (!DRY) fs.renameSync(src, target);
}

ensureOutputDirs();
let moved = 0;
// 1. Top-level scratch files
for (const name of fs.existsSync(PENDING) ? fs.readdirSync(PENDING) : []) {
  const full = path.join(PENDING, name);
  let stat; try { stat = fs.statSync(full); } catch { continue; }
  if (!stat.isFile()) continue;
  for (const r of RULES) {
    if (r.test(name) && ageDays(full) >= r.graceDays) {
      move(full, path.join(WORKING, r.dest), name); moved++; break;
    }
  }
}
// 2. Contents of pipeline asset dirs (keep the dir, sweep aged files inside)
for (const s of SWEEP_DIR_CONTENTS) {
  const dir = path.join(PENDING, s.dir);
  if (!fs.existsSync(dir)) continue;
  for (const name of fs.readdirSync(dir)) {
    if (name === '.DS_Store') continue;
    const full = path.join(dir, name);
    try { if (ageDays(full) >= s.graceDays) { move(full, path.join(WORKING, s.dest), name); moved++; } }
    catch { /* skip */ }
  }
}
console.log(`janitor: ${moved} item(s) ${DRY ? 'would move' : 'moved'} out of pending. Review queue left untouched.`);
