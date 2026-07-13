'use strict';
/* ============================================================================
 * pipeline.js — the clean turnkey content pipeline.
 *
 * A lean, config-driven runner: topics -> write -> grade -> visuals -> route.
 * No video, no voice cloning, no brand-specific branches. Everything it does is
 * steered by config/config.json (see config/README.md).
 *
 * It orchestrates the per-stage agents as subprocesses (same model as
 * orchestrator/run.py). Each agent is single-purpose and independently runnable;
 * this file just sequences them and applies the approve-vs-auto decision.
 *
 *   node pipeline.js --once      run the full chain now
 *   node pipeline.js --dry       plan only: print what would run, touch nothing
 * ========================================================================== */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'config', 'config.json');

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error('Missing config/config.json — copy config/config.example.json and fill it in (see ONBOARDING.md).');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function enabledPlatforms(cfg) {
  return Object.entries(cfg.platforms || {})
    .filter(([k, v]) => v === true && !k.startsWith('_'))
    .map(([k]) => k);
}

// Stage runner: each agent reads config + writes its output to the sheet /
// output dir. We pass the config path so agents never hardcode anything.
function runStage(label, cmd, args, { dry }) {
  console.log(`\n=== ${label} ===`);
  if (dry) { console.log(`  [dry] would run: ${cmd} ${args.join(' ')}`); return; }
  try {
    execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit', env: process.env });
  } catch (e) {
    // Record and continue — one failing stage should not abort the whole run.
    // The alerts agent (called at the end) surfaces any FAIL to you.
    console.error(`  ${label} FAILED (exit ${e.status}). Continuing; alerts will flag it.`);
    return false;
  }
  return true;
}

function main() {
  const dry = process.argv.includes('--dry');
  const cfg = loadConfig();
  const platforms = enabledPlatforms(cfg);
  const mode = (cfg.approval && cfg.approval.mode) || 'approve';

  console.log(`Content Machine — brand: ${cfg.brand?.name} | platforms: ${platforms.join(', ') || '(none)'} | mode: ${mode}`);

  // 1. TOPICS — manual list, or optional scraper (agent2). Manual needs no APIs.
  if (cfg.topics?.mode === 'scraper' && cfg.topics?.scraper?.enabled) {
    runStage('Scout (trend scraper)', 'node', ['agents/agent2-scout.js', '--once', '--config', CONFIG_PATH], { dry });
  } else {
    console.log('\n=== Topics ===\n  Using manual topics from config (no scraper).');
  }

  // 2. WRITE — articles + platform-specific social copy, in your voice.
  runStage('Write (articles + social copy)', 'node', ['agents/agent3-writer.js', '--config', CONFIG_PATH], { dry });

  // 3. GRADE — score each draft against the voice spec; weak drafts rewritten/dropped.
  runStage('Grade (voice quality gate)', 'node', ['agents/quality-monitor.js', '--config', CONFIG_PATH], { dry });

  // 4. VISUALS — Canva posts from YOUR templates (only if any social platform is on).
  if (platforms.length) {
    runStage('Canva posts', 'node', ['agents/agent3c-canva.js', '--config', CONFIG_PATH], { dry });
  }

  // 5. ARTICLES — write finished articles to output/ for you to publish anywhere.
  if (cfg.articles?.enabled) {
    runStage('Article files', 'node', ['agents/aeo-weekly.js', '--files-only', '--config', CONFIG_PATH], { dry });
  }

  // 6. ROUTE — approve vs auto. This is the whole safety model.
  if (mode === 'auto') {
    runStage('Schedule (auto)', 'node', ['agents/agent5-scheduler.js', '--all-approved', '--config', CONFIG_PATH], { dry });
  } else {
    runStage('Request approval (email)', 'node', ['agents/approval-handler.js', '--send-review', '--config', CONFIG_PATH], { dry });
    console.log('  Approve by replying to the email; only then does anything schedule.');
  }

  // 7. REPORT + fail-safe.
  runStage('Daily report', 'node', ['agents/agent6b-daily-reporter.js', '--config', CONFIG_PATH], { dry });
  runStage('Alerts (dead-man\'s switch)', 'node', ['agents/alerts.js', '--check'], { dry });

  console.log('\nDone.');
}

main();
