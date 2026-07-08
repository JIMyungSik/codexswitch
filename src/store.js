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
  return meta;
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
  if (!accountExists(name)) throw new Error(`no such account: ${name} (see "codexteam list")`);
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
        priority: m.priority ?? 0,
        disabled: !!m.disabled,
        limitedUntil: m.limitedUntil || null,
        active: meta.active === name,
      };
    })
    .sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
}

// Copy refreshed tokens from a live auth.json back into the store, so a
// token refresh done by codex itself is never lost when we switch accounts.
// Matches by account_id; prefers the account we believe deployed the file.
function syncBackFrom(authFile) {
  const cur = readJSONSafe(authFile);
  if (!cur) return null;
  const curInfo = authInfo(cur);
  if (!curInfo.accountId) return null;
  const meta = loadMeta();
  const candidates = listAccounts().filter((a) => a.accountId === curInfo.accountId);
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

function clearLimited(name) {
  const meta = loadMeta();
  if (meta.accounts[name] && meta.accounts[name].limitedUntil) {
    delete meta.accounts[name].limitedUntil;
    saveMeta(meta);
  }
}

// Pick the best usable account: enabled, not currently rate-limited,
// lowest priority number first. `exclude` skips accounts already tried.
function pickAccount(exclude = []) {
  const now = Date.now();
  const usable = listAccounts().filter(
    (a) => !a.disabled && !exclude.includes(a.name) && (!a.limitedUntil || a.limitedUntil <= now)
  );
  if (usable.length === 0) return null;
  const active = usable.find((a) => a.active);
  return active || usable[0];
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
  pickAccount,
  ensureDirs() {
    const p = paths();
    ensureDir(p.home);
    ensureDir(p.accountsDir);
    ensureDir(p.profilesDir);
  },
};
