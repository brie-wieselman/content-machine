#!/usr/bin/env node
/* ============================================================================
 * alerts.js — dead-man's switch for the Content Machine.
 *
 * Problem this solves (a real incident): the pipeline ran perfectly but BOTH
 * alert channels failed silently in one morning — the operator discovered the
 * failure only by noticing silence. Never again. So alert() tries EVERY
 * channel and reports which worked:
 *
 *   1. Email via mailer.js (Gmail ADC) — to config.approval.approval_channel_email
 *   2. Local desktop notification (macOS osascript / Linux notify-send) —
 *      cannot rot the way an API token can; fires on the machine you work on
 *   3. logs/ALERT-<date>.txt — always written, even if 1 and 2 both fail
 *
 * Wired as the LAST stage of pipeline.js (`--check`): if any earlier stage
 * logged a FAIL today, you hear about it through every channel at once.
 *
 * CLI:
 *   node agents/alerts.js --test                       fire a test alert
 *   node agents/alerts.js --send "subject" "body"      fire a custom alert
 *   node agents/alerts.js --check [--config <path>]    alert if today's pipeline log has FAILs
 * ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const { LOG_DIR, loadConfig, ts, todayLocal, makeLogger } = require('./common');
const log = makeLogger('alerts');

// ---- channels ---------------------------------------------------------------
async function tryEmail(subject, body, config) {
  try {
    const { sendMail } = require('./mailer');
    // Alerts must never be swallowed by pipeline email-suppression.
    const prev = process.env.CM_FORCE_EMAIL;
    process.env.CM_FORCE_EMAIL = '1';
    try { await sendMail(subject, body, { config }); } finally {
      if (prev === undefined) delete process.env.CM_FORCE_EMAIL; else process.env.CM_FORCE_EMAIL = prev;
    }
    return { ok: true, why: 'sent' };
  } catch (e) { return { ok: false, why: (e.message || '').slice(0, 140) }; }
}

function tryLocalNotification(subject, body) {
  // Escapes go through stdin/args — immune to shell-quoting breaks (apostrophes etc.)
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').slice(0, 200);
  try {
    if (process.platform === 'darwin') {
      execSync('osascript', { input: `display notification "${esc(body)}" with title "${esc(subject)}" sound name "Basso"`, timeout: 10000 });
      return { ok: true, why: 'shown' };
    }
    if (process.platform === 'linux') {
      execSync(`notify-send "${esc(subject)}" "${esc(body)}"`, { timeout: 10000 });
      return { ok: true, why: 'shown' };
    }
    return { ok: false, why: `no local-notification support on ${process.platform}` };
  } catch (e) { return { ok: false, why: e.message }; }
}

// ---- the alert ----------------------------------------------------------------
async function alert(subject, body, config = null) {
  // 3. File first — it can never fail for network reasons.
  const file = path.join(LOG_DIR, `ALERT-${ts().slice(0, 10)}.txt`);
  try { fs.appendFileSync(file, `\n[${ts()}] ${subject}\n${body}\n`); } catch (_) {}
  const em = await tryEmail(`🚨 ${subject}`, body, config);
  const local = tryLocalNotification(subject, body.split('\n')[0]);
  log(`ALERT "${subject}" → email:${em.ok ? 'OK' : 'FAIL(' + em.why + ')'} local:${local.ok ? 'OK' : 'FAIL(' + local.why + ')'} file:written`);
  return { email: em.ok, local: local.ok, file };
}

// ---- --check: scan today's pipeline log for FAILed stages ---------------------
async function checkPipeline(config) {
  const f = path.join(LOG_DIR, 'pipeline-log.txt');
  let fails = [];
  try {
    fails = fs.readFileSync(f, 'utf8').split('\n')
      .filter((l) => l.includes(todayLocal()) && /\bFAIL\b/.test(l));
  } catch (_) { /* no log yet — nothing to check */ }
  if (!fails.length) { log('--check: no FAILs in today\'s pipeline log — all clear'); return { fails: 0 }; }
  const body = `The pipeline logged ${fails.length} FAILed stage(s) today:\n\n${fails.slice(0, 10).join('\n')}\n\nSee logs/pipeline-log.txt for detail.`;
  const r = await alert(`Content Machine: ${fails.length} pipeline stage(s) FAILED today`, body, config);
  return { fails: fails.length, ...r };
}

module.exports = { alert, checkPipeline };

// CLI
if (require.main === module) {
  (async () => {
    const argv = process.argv.slice(2);
    const config = loadConfig();
    if (argv.includes('--test')) {
      const r = await alert('Content Machine alert test', 'If you can read this, the dead-man\'s switch works.', config);
      console.log('RESULT:', JSON.stringify(r));
    } else if (argv.includes('--check')) {
      const r = await checkPipeline(config);
      console.log('RESULT:', JSON.stringify(r));
    } else if (argv[0] === '--send' && argv[1]) {
      const r = await alert(argv[1], argv[2] || argv[1], config);
      console.log('RESULT:', JSON.stringify(r));
    } else {
      console.log('Usage: node agents/alerts.js --test | --check | --send "subject" "body"   [--config <path>]');
    }
    process.exit(0);
  })();
}
