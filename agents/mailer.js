'use strict';
/* ============================================================================
 * mailer.js — shared Gmail sender for all agents.
 *
 * Fixes two real-world bugs worth keeping:
 *  1. UTF-8 subjects — non-ASCII (emoji) subjects are RFC 2047 encoded so
 *     clients don't render them as garbled "Ã¢ÂÂ…".
 *  2. Sender display name — From is set explicitly to your brand name
 *     (config.brand.name), not the Google account's default display name.
 *
 * Addresses:
 *  - from-address:  MAIL_SENDER in .env
 *  - recipient:     config.approval.approval_channel_email (falls back to sender)
 *  - display name:  config.brand.name
 *
 * Pipeline mode: set CM_SUPPRESS_EMAIL=1 and individual agents stay quiet so
 * the daily reporter can send ONE consolidated digest instead of five separate
 * mails. The reporter itself bypasses suppression via CM_FORCE_EMAIL=1.
 *
 * Auth: Google Application Default Credentials (see ONBOARDING.md Step 4).
 * ========================================================================== */

const { envReader, loadConfig } = require('./common');

function encodeSubjectUtf8(subject) {
  // RFC 2047 "encoded-word" for non-ASCII subject headers.
  return '=?UTF-8?B?' + Buffer.from(subject, 'utf8').toString('base64') + '?=';
}

function buildRawMessage({ sender, recipient, fromName, subject, body, html }) {
  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
  let msg;
  if (html) {
    // multipart/alternative: plain-text fallback + HTML
    const boundary = 'cmdigest_' + Buffer.from(subject).toString('hex').slice(0, 16);
    msg = [
      `From: ${fromName} <${sender}>`,
      `To: ${recipient}`,
      `Subject: ${encodeSubjectUtf8(subject)}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      b64(body),
      '',
      `--${boundary}`,
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      b64(html),
      '',
      `--${boundary}--`,
    ].join('\r\n');
  } else {
    msg = [
      `From: ${fromName} <${sender}>`,
      `To: ${recipient}`,
      `Subject: ${encodeSubjectUtf8(subject)}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      b64(body),
    ].join('\r\n');
  }
  return Buffer.from(msg, 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Send an email. `config` is optional — pass a loaded config to avoid a
 * re-read; otherwise the default config path is used.
 */
async function sendMail(subject, body, { html = null, config = null } = {}) {
  if (process.env.CM_SUPPRESS_EMAIL === '1' && process.env.CM_FORCE_EMAIL !== '1') {
    console.log(`[mailer] suppressed (pipeline mode): ${subject}`);
    return 'suppressed';
  }
  const cfg = config || loadConfig();
  const env = envReader();
  const sender = env('MAIL_SENDER');
  if (!sender) throw new Error('MAIL_SENDER not set in .env — see .env.example');
  const recipient = (cfg.approval && cfg.approval.approval_channel_email) || sender;
  const fromName = (cfg.brand && cfg.brand.name) || 'Content Machine';

  const { google } = require('googleapis');
  const auth = new google.auth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/gmail.send'] });
  const gmail = google.gmail({ version: 'v1', auth: await auth.getClient() });
  const raw = buildRawMessage({ sender, recipient, fromName, subject, body, html });
  const r = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
  return r.data.id;
}

module.exports = { sendMail, buildRawMessage, encodeSubjectUtf8 };
