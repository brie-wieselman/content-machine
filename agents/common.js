'use strict';
/* ============================================================================
 * common.js — shared plumbing for every agent.
 *
 * One place for: config loading (--config <path>, default config/config.json),
 * repo-root .env parsing, output-directory layout, logging, and model choice.
 * Agents go through this module so nothing hardcodes a path, key, or ID.
 * ========================================================================== */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LOG_DIR = path.join(ROOT, 'logs');
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (_) {}

// Output layout — the engine's entire filesystem surface. Content packages land
// in pending/, move to approved/ or rejected/ on your reply, articles are
// written to articles/, and queue/ holds items waiting on the scheduler.
const OUT = {
  root: path.join(ROOT, 'output'),
  pending: path.join(ROOT, 'output', 'pending'),
  approved: path.join(ROOT, 'output', 'approved'),
  rejected: path.join(ROOT, 'output', 'rejected'),
  articles: path.join(ROOT, 'output', 'articles'),
  queue: path.join(ROOT, 'output', 'queue'),
  working: path.join(ROOT, 'output', '_working'),
};
function ensureOutputDirs() {
  for (const d of Object.values(OUT)) { try { fs.mkdirSync(d, { recursive: true }); } catch (_) {} }
}

// ---- .env (repo root only — secrets never live in config files) ----
function parseEnvFile(p) {
  const env = {};
  try {
    fs.readFileSync(p, 'utf8').split(/\r?\n/).forEach((ln) => {
      const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) env[m[1]] = m[2].trim();
    });
  } catch (_) {}
  return env;
}
function envReader() {
  const fileEnv = parseEnvFile(path.join(ROOT, '.env'));
  return (...keys) => {
    for (const k of keys) {
      const v = (process.env[k] || fileEnv[k] || '').trim();
      if (v) return v;
    }
    return '';
  };
}

// ---- config (--config <path>, default config/config.json) ----
function configPath(argv = process.argv) {
  const i = argv.indexOf('--config');
  if (i >= 0 && argv[i + 1]) return path.resolve(argv[i + 1]);
  return path.join(ROOT, 'config', 'config.json');
}
function loadConfig(argv = process.argv) {
  const p = configPath(argv);
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (_) {
    console.error(`[config] could not read ${p} — copy config/config.example.json to config/config.json and fill it in (see ONBOARDING.md).`);
    return {};
  }
}

// ---- model ----
// Default writing/analysis model; override with ANTHROPIC_MODEL in .env.
function model(env) { return (env && env('ANTHROPIC_MODEL')) || process.env.ANTHROPIC_MODEL || 'claude-sonnet-5'; }

// ---- logging ----
const ts = () => new Date().toISOString();
function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function makeLogger(name) {
  const file = path.join(LOG_DIR, `${name}-log.txt`);
  const log = (m) => {
    const l = `[${ts()}] ${m}`;
    console.log(l);
    try { fs.appendFileSync(file, l + '\n'); } catch (_) {}
  };
  log.err = (scope, e) => log(`ERROR [${scope}]: ${e && e.message ? e.message : e}`);
  return log;
}

module.exports = { ROOT, LOG_DIR, OUT, ensureOutputDirs, envReader, configPath, loadConfig, model, ts, todayLocal, makeLogger };
