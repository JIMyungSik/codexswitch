'use strict';

const fs = require('fs');
const path = require('path');

function ensureDir(dir, mode = 0o700) {
  fs.mkdirSync(dir, { recursive: true, mode });
}

function readJSON(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readJSONSafe(file, fallback = null) {
  try {
    return readJSON(file);
  } catch {
    return fallback;
  }
}

// Write JSON atomically (tmp file + rename) so a crash never leaves a
// half-written auth/meta file behind.
function writeJSONAtomic(file, data, mode = 0o600) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode });
  fs.renameSync(tmp, file);
}

// Decode a JWT payload without verifying the signature. We only use this to
// display identity info (email, plan) that codex already trusts locally.
function decodeJwtPayload(token) {
  try {
    const part = token.split('.')[1];
    const pad = part + '='.repeat((4 - (part.length % 4)) % 4);
    return JSON.parse(Buffer.from(pad, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

// Extract display info from a codex auth.json object.
function authInfo(auth) {
  const info = { email: null, plan: null, accountId: null, lastRefresh: null };
  if (!auth || typeof auth !== 'object') return info;
  info.lastRefresh = auth.last_refresh || null;
  const tokens = auth.tokens || {};
  info.accountId = tokens.account_id || null;
  const payload = tokens.id_token ? decodeJwtPayload(tokens.id_token) : null;
  if (payload) {
    info.email = payload.email || null;
    const oa = payload['https://api.openai.com/auth'] || {};
    info.plan = oa.chatgpt_plan_type || null;
    if (!info.accountId) info.accountId = oa.chatgpt_account_id || null;
  }
  if (!info.email && auth.OPENAI_API_KEY) info.email = '(api key)';
  return info;
}

// Parse durations like "2 hours 30 minutes", "5h", "3 days" into ms.
function parseDurationMs(text) {
  if (!text) return null;
  let ms = 0;
  const re = /(\d+(?:\.\d+)?)\s*(d(?:ays?)?|h(?:ours?|rs?)?|m(?:in(?:utes?)?)?|s(?:ec(?:onds?)?)?)\b/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const n = parseFloat(m[1]);
    const unit = m[2][0].toLowerCase();
    ms += n * { d: 86400000, h: 3600000, m: 60000, s: 1000 }[unit];
  }
  return ms > 0 ? ms : null;
}

function fmtDate(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return String(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtRemaining(untilTs) {
  const ms = untilTs - Date.now();
  if (ms <= 0) return 'now';
  const h = Math.floor(ms / 3600000);
  const m = Math.round((ms % 3600000) / 60000);
  return h > 0 ? `${h}h${m}m` : `${m}m`;
}

function table(rows, headers) {
  const { visible, dim } = require('./ui.js');
  const all = [headers, ...rows].map((r) => r.map((c) => String(c == null ? '-' : c)));
  const widths = headers.map((_, i) => Math.max(...all.map((r) => visible(r[i]).length)));
  const pad = (c, w) => c + ' '.repeat(Math.max(0, w - visible(c).length));
  const line = (r) => r.map((c, i) => pad(c, widths[i])).join('  ').trimEnd();
  return [dim(line(all[0])), dim(line(widths.map((w) => '-'.repeat(w)))), ...all.slice(1).map(line)].join('\n');
}

module.exports = {
  ensureDir,
  readJSON,
  readJSONSafe,
  writeJSONAtomic,
  decodeJwtPayload,
  authInfo,
  parseDurationMs,
  fmtDate,
  fmtRemaining,
  table,
};
