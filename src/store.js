'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { ensureDir, readJSON, readJSONSafe, writeJSONAtomic, authInfo } = require('./util.js');

// Directory layout:
//   ~/.codex-switch/
//     meta.json          account registry (priority/disabled/limits) + active name
//     accounts/<name>.json   stored copy of that account's codex auth.json
//     profiles/<name>/       per-account CODEX_HOME overlay used by `run`/`exec`
// Overridable for tests / custom setups via CODEX_SWITCH_HOME.
function paths() {
  const home = process.env.CODEX_SWITCH_HOME || path.join(os.homedir(), '.codex-switch');
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return {
    home,
    codexHome,
    accountsDir: path.join(home, 'accounts'),
    profilesDir: path.join(home, 'profiles'),
    metaPath: path.join(home, 'meta.json'),
    authPath: path.join(codexHome, 'auth.json'),
  };
}

function loadMeta() {
  const p = paths();
  const meta = readJSONSafe(p.metaPath, {}) || {};
  if (!meta.accounts) meta.accounts = {};
  if (!('active' in meta)) meta.active = null;
  if (!meta.cooldownMinutes) meta.cooldownMinutes = 60;
  if (!meta.threshold5h) meta.threshold5h = 95;
  if (!meta.thresholdWeekly) meta.thresholdWeekly = 95;
  if (!Array.isArray(meta.limitPatterns)) meta.limitPatterns = [];
  return meta;
}

// Append an event to the activity log (rotations, limits, auth failures...).
function logEvent(type, message) {
  try {
    ensureDir(paths().home);
    fs.appendFileSync(
      path.join(paths().home, 'activity.log'),
      JSON.stringify({ at: new Date().toISOString(), type, message }) + '\n'
    );
  } catch {
    /* logging must never break the tool */
  }
}

function readEvents(count = 20) {
  try {
    const lines = fs.readFileSync(path.join(paths().home, 'activity.log'), 'utf8').trim().split('\n');
    return lines.slice(-count).map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function saveMeta(meta) {
  writeJSONAtomic(paths().metaPath, meta);
}

function accountPath(name) {
  // Unicode letters/digits are fine (names become filenames); block path
  // separators, traversal, and characters invalid on Windows filesystems.
  if (!/^[\p{L}\p{N}@._+ -]+$/u.test(name) || name.includes('..') || /^[. ]|[. ]$/.test(name)) {
    throw new Error(`invalid account name "${name}" (letters, digits, spaces, @ . _ + - only)`);
  }
  return path.join(paths().accountsDir, `${name}.json`);
}

function accountExists(name) {
  try {
    return fs.existsSync(accountPath(name));
  } catch {
    return false;
  }
}

function readAccountAuth(name) {
  if (!accountExists(name)) throw new Error(`no such account: ${name} (see "codexswitch list")`);
  return readJSON(accountPath(name));
}

function writeAccountAuth(name, auth) {
  writeJSONAtomic(accountPath(name), auth, 0o600);
}

function listAccounts() {
  const p = paths();
  const meta = loadMeta();
  let files = [];
  try {
    files = fs.readdirSync(p.accountsDir).filter((f) => f.endsWith('.json'));
  } catch {
    /* no accounts yet */
  }
  return files
    .map((f) => {
      const name = f.slice(0, -5);
      const auth = readJSONSafe(path.join(p.accountsDir, f));
      const m = meta.accounts[name] || {};
      return {
        name,
        ...authInfo(auth),
        priority: m.priority ?? null, // null = auto (use-or-lose ordering)
        disabled: !!m.disabled,
        limitedUntil: m.limitedUntil || null,
        usage: m.usage || null,
        active: meta.active === name,
      };
    })
    .sort(rotationCompare);
}

// Rotation order: pinned accounts (explicit priority) come first in pin
// order; auto accounts follow, spending the one whose weekly quota resets
// soonest first (use-or-lose — quota about to refresh anyway gets burned
// first). Ties prefer the active account to avoid needless switching.
function rotationCompare(a, b) {
  const aPinned = a.priority != null;
  const bPinned = b.priority != null;
  if (aPinned !== bPinned) return aPinned ? -1 : 1;
  if (aPinned && a.priority !== b.priority) return a.priority - b.priority;
  const reset = (x) => (x.usage && x.usage.weekly && x.usage.weekly.resetAt) || Infinity;
  return reset(a) - reset(b) || Number(b.active) - Number(a.active) || a.name.localeCompare(b.name);
}

// Copy refreshed tokens from a live auth.json back into the store, so a
// token refresh done by codex itself is never lost when we switch accounts.
// Matches by email first: team-plan accounts share one chatgpt_account_id
// per workspace, so matching by account_id alone would let two teammates'
// tokens overwrite each other. Falls back to account_id for tokens without
// an email claim. Prefers the account we believe deployed the file.
function syncBackFrom(authFile) {
  const cur = readJSONSafe(authFile);
  if (!cur) return null;
  const curInfo = authInfo(cur);
  if (!curInfo.accountId) return null;
  const meta = loadMeta();
  const all = listAccounts();
  const byEmail = curInfo.email ? all.filter((a) => a.email === curInfo.email) : [];
  const candidates = byEmail.length > 0 ? byEmail : all.filter((a) => a.accountId === curInfo.accountId);
  if (candidates.length === 0) return null;
  const target = candidates.find((a) => a.name === meta.active) || candidates[0];
  const stored = readAccountAuth(target.name);
  const newer =
    !stored.last_refresh || (cur.last_refresh && cur.last_refresh > stored.last_refresh);
  if (newer && JSON.stringify(stored) !== JSON.stringify(cur)) {
    writeAccountAuth(target.name, cur);
    return target.name;
  }
  return null;
}

function syncBack() {
  return syncBackFrom(paths().authPath);
}

function markLimited(name, untilTs) {
  const meta = loadMeta();
  if (!meta.accounts[name]) meta.accounts[name] = {};
  meta.accounts[name].limitedUntil = untilTs;
  saveMeta(meta);
}

function clearLimited(name, { includeUsage = false } = {}) {
  const meta = loadMeta();
  const m = meta.accounts[name];
  if (m && (m.limitedUntil || (includeUsage && m.usage))) {
    delete m.limitedUntil;
    if (includeUsage) delete m.usage;
    saveMeta(meta);
  }
}

function saveUsage(name, usage) {
  const meta = loadMeta();
  if (!meta.accounts[name]) meta.accounts[name] = {};
  meta.accounts[name].usage = usage;
  saveMeta(meta);
}

// An account is "over threshold" when its last recorded 5h/weekly usage
// exceeds the configured percentage and the window has not reset yet.
// Returns the blocking window ('5h' | 'weekly') or null.
function overThreshold(account, meta, now = Date.now()) {
  const u = account.usage;
  if (!u) return null;
  const checks = [
    ['5h', u.p5h, meta.threshold5h],
    ['weekly', u.weekly, meta.thresholdWeekly],
  ];
  for (const [label, win, threshold] of checks) {
    if (!win || typeof win.pct !== 'number') continue;
    if (win.pct < threshold) continue;
    // Trust the snapshot only while its window can still be in effect.
    if (win.resetAt) {
      if (win.resetAt > now) return label;
    } else if (win.windowMinutes && u.at + win.windowMinutes * 60000 > now) {
      return label;
    }
  }
  return null;
}

function isUsable(account, meta, now = Date.now()) {
  if (account.disabled) return false;
  if (account.limitedUntil && account.limitedUntil > now) return false;
  if (overThreshold(account, meta, now)) return false;
  return true;
}

// Pick the best usable account: enabled, not currently rate-limited,
// lowest priority number first (the order set by "order"/"priority").
// The active account only wins ties within the same priority, so an
// explicit order is always respected. `exclude` skips accounts already tried.
function pickAccount(exclude = []) {
  const now = Date.now();
  const meta = loadMeta();
  const usable = listAccounts().filter((a) => !exclude.includes(a.name) && isUsable(a, meta, now));
  if (usable.length === 0) return null;
  // listAccounts is already in rotation order (pins first, then use-or-lose,
  // active as tiebreaker) — but a pinned tie should still stick to active.
  const top = usable.filter((a) => a.priority != null && a.priority === usable[0].priority);
  return top.find((a) => a.active) || usable[0];
}

// Next usable account after the active one, following priority order and
// wrapping around — so repeated "next" cycles through the configured order.
function nextAccount() {
  const all = listAccounts();
  const now = Date.now();
  const meta = loadMeta();
  const start = all.findIndex((a) => a.active);
  for (let i = 1; i <= all.length; i++) {
    const cand = all[(start + i) % all.length];
    if (!cand.active && isUsable(cand, meta, now)) return cand;
  }
  return null;
}

module.exports = {
  paths,
  loadMeta,
  saveMeta,
  accountPath,
  accountExists,
  readAccountAuth,
  writeAccountAuth,
  listAccounts,
  syncBack,
  syncBackFrom,
  markLimited,
  clearLimited,
  saveUsage,
  overThreshold,
  isUsable,
  pickAccount,
  nextAccount,
  logEvent,
  readEvents,
  ensureDirs() {
    const p = paths();
    ensureDir(p.home);
    ensureDir(p.accountsDir);
    ensureDir(p.profilesDir);
  },
};
