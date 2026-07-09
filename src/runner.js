'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { ensureDir, parseDurationMs } = require('./util.js');
const store = require('./store.js');

let cachedBin = null;

// Resolve the codex binary. On Windows an npm-installed codex is usually a
// "codex.cmd" shim which Node refuses to spawn directly (EINVAL), so resolve
// the real path via `where` and prefer a native .exe when one exists.
function codexBin() {
  if (process.env.CODEX_SWITCH_CODEX_BIN) return process.env.CODEX_SWITCH_CODEX_BIN;
  if (cachedBin) return cachedBin;
  cachedBin = 'codex';
  if (process.platform === 'win32') {
    const r = spawnSync('where', ['codex'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout) {
      const lines = r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      cachedBin = lines.find((l) => /\.exe$/i.test(l)) || lines[0] || 'codex';
    }
  }
  return cachedBin;
}

// cmd.exe argument quoting for the .cmd/.bat shim case (shell: true).
function winQuote(arg) {
  if (arg === '') return '""';
  if (!/[\s"^&|<>()%!;,=]/.test(arg)) return arg;
  return '"' + arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1') + '"';
}

// Node cannot spawn .cmd/.bat files without a shell; wrap args accordingly.
function spawnPlan(args) {
  const bin = codexBin();
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin)) {
    return { bin: winQuote(bin), args: args.map(winQuote), shell: true };
  }
  return { bin, args, shell: false };
}

function spawnCodexSync(args, options = {}) {
  const plan = spawnPlan(args);
  return spawnSync(plan.bin, plan.args, { ...options, shell: plan.shell });
}

function assertCodexAvailable() {
  const r = spawnCodexSync(['--version'], { stdio: 'ignore' });
  if ((r.error && r.error.code === 'ENOENT') || r.status === 127) {
    throw new Error(
      `codex CLI not found ("${codexBin()}"). Install it with "npm install -g @openai/codex" or set CODEX_SWITCH_CODEX_BIN to its path.`
    );
  }
}

// Build a per-account CODEX_HOME overlay: every top-level entry of the real
// CODEX_HOME is symlinked into the profile so config, sessions, skills and
// history are shared — except auth.json (per-account, copied from the store)
// and sqlite databases (excluded: two codex processes writing the same
// sqlite file through symlinks risks corruption; each profile keeps its own).
function buildProfile(name) {
  const p = store.paths();
  const profile = path.join(p.profilesDir, name);
  ensureDir(profile);

  // Sessions must exist in the real CODEX_HOME before linking, so that every
  // profile shares them — resume-on-rotation and usage tracking depend on it.
  ensureDir(path.join(p.codexHome, 'sessions'), 0o755);

  let entries = [];
  try {
    entries = fs.readdirSync(p.codexHome);
  } catch {
    /* no real codex home yet — profile starts empty */
  }

  // Drop stale symlinks (target removed, or entry no longer shareable).
  for (const entry of fs.readdirSync(profile)) {
    const dest = path.join(profile, entry);
    let st;
    try {
      st = fs.lstatSync(dest);
    } catch {
      continue;
    }
    if (!st.isSymbolicLink()) continue;
    const shouldExist = entries.includes(entry) && shareable(entry);
    if (!shouldExist || !fs.existsSync(dest)) fs.rmSync(dest, { force: true });
  }

  for (const entry of entries) {
    if (!shareable(entry)) continue;
    const dest = path.join(profile, entry);
    const target = path.join(p.codexHome, entry);
    if (isLink(dest)) continue;
    if (fs.existsSync(dest)) {
      // Windows copy fallback: refresh the copy when the original changed.
      if (process.platform === 'win32') refreshCopy(target, dest);
      continue;
    }
    linkEntry(target, dest);
  }

  const auth = store.readAccountAuth(name);
  const authFile = path.join(profile, 'auth.json');
  fs.writeFileSync(authFile, JSON.stringify(auth, null, 2) + '\n', { mode: 0o600 });
  return profile;
}

function shareable(entry) {
  if (entry === 'auth.json') return false;
  if (/\.sqlite(-wal|-shm|-journal)?$/.test(entry)) return false;
  if (entry === 'tmp') return false;
  return true;
}

function isLink(file) {
  try {
    return fs.lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

// Share one entry into the profile. POSIX: plain symlink. Windows: junction
// for directories (no admin required); for files try a symlink (works with
// Developer Mode) and fall back to a plain copy.
function linkEntry(target, dest) {
  let isDir = false;
  try {
    isDir = fs.statSync(target).isDirectory();
  } catch {
    return;
  }
  if (process.platform !== 'win32') {
    fs.symlinkSync(target, dest);
    return;
  }
  try {
    fs.symlinkSync(target, dest, isDir ? 'junction' : 'file');
  } catch {
    if (!isDir) {
      try {
        fs.copyFileSync(target, dest);
      } catch {
        /* unshareable entry — codex will recreate what it needs */
      }
    }
  }
}

function refreshCopy(target, dest) {
  try {
    const s = fs.statSync(target);
    const d = fs.statSync(dest);
    if (s.isFile() && d.isFile() && s.mtimeMs > d.mtimeMs) fs.copyFileSync(target, dest);
  } catch {
    /* best effort */
  }
}

// Run codex for one account inside its overlay profile.
// capture=false: interactive, stdio inherited. capture=true: stream output
// through while also collecting it so the caller can detect limit errors.
function runCodex(name, args, { capture = false } = {}) {
  assertCodexAvailable();
  const profile = buildProfile(name);
  const env = { ...process.env, CODEX_HOME: profile };

  return new Promise((resolve) => {
    const plan = spawnPlan(args);
    const child = spawn(plan.bin, plan.args, {
      env,
      shell: plan.shell,
      stdio: capture ? ['inherit', 'pipe', 'pipe'] : 'inherit',
    });
    let out = '';
    if (capture) {
      const collect = (stream, dest) => {
        stream.on('data', (chunk) => {
          out += chunk.toString('utf8');
          if (out.length > 262144) out = out.slice(-131072);
          dest.write(chunk);
        });
      };
      collect(child.stdout, process.stdout);
      collect(child.stderr, process.stderr);
    }
    child.on('error', (err) => resolve({ code: 1, output: out, error: err, profile }));
    child.on('close', (code) => {
      // codex may have refreshed the token while running — persist it.
      try {
        store.syncBackFrom(path.join(profile, 'auth.json'));
      } catch {
        /* best effort */
      }
      resolve({ code: code == null ? 1 : code, output: out, profile });
    });
  });
}

// ---- usage tracking ---------------------------------------------------
// Codex writes token_count events into session rollout files; when the
// backend sends x-codex-* headers they include rate_limits with the 5h
// (primary) and weekly (secondary) used_percent and reset times. Some
// exec-mode versions report null there, so all parsing is best-effort.

function listRolloutsSince(sessionsDir, sinceMs) {
  const found = [];
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && depth < 4) walk(full, depth + 1);
      else if (e.isFile() && /^rollout-.*\.jsonl$/.test(e.name)) {
        try {
          const st = fs.statSync(full);
          if (st.mtimeMs >= sinceMs) found.push({ full, mtime: st.mtimeMs });
        } catch {
          /* ignore */
        }
      }
    }
  };
  walk(sessionsDir, 0);
  return found.sort((a, b) => a.mtime - b.mtime);
}

function windowUsage(win, eventTs) {
  if (!win || typeof win.used_percent !== 'number') return null;
  const usage = { pct: win.used_percent, resetAt: null, windowMinutes: win.window_minutes || null };
  if (typeof win.resets_in_seconds === 'number') usage.resetAt = eventTs + win.resets_in_seconds * 1000;
  else if (typeof win.resets_at === 'number') usage.resetAt = win.resets_at * 1000;
  return usage;
}

// Scan rollouts touched since `sinceMs` for the newest non-null rate_limits
// snapshot. Returns { p5h, weekly, at } or null when codex reported nothing.
function scanUsage(sessionsDir, sinceMs) {
  let result = null;
  for (const f of listRolloutsSince(sessionsDir, sinceMs)) {
    let text;
    try {
      text = fs.readFileSync(f.full, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.includes('rate_limits')) continue;
      try {
        const obj = JSON.parse(line);
        const rl = (obj.payload && obj.payload.rate_limits) || obj.rate_limits;
        if (!rl) continue;
        const eventTs = obj.timestamp ? Date.parse(obj.timestamp) || Date.now() : Date.now();
        const p5h = windowUsage(rl.primary, eventTs);
        const weekly = windowUsage(rl.secondary, eventTs);
        if (p5h || weekly) result = { p5h, weekly, at: eventTs };
      } catch {
        /* malformed line */
      }
    }
  }
  return result;
}

// After running codex for an account, persist the freshest usage snapshot.
function recordUsage(name, profile, sinceMs) {
  const usage = scanUsage(path.join(profile, 'sessions'), sinceMs);
  if (usage) store.saveUsage(name, usage);
  return usage;
}

// Was a session rollout created/updated during this run? (drives whether a
// rotated retry can "exec resume" instead of restarting from scratch)
function sessionTouchedSince(profile, sinceMs) {
  return listRolloutsSince(path.join(profile, 'sessions'), sinceMs).length > 0;
}

const LIMIT_RE =
  /usage[ _]limit|rate[ _]limit|too many requests|quota (?:exceeded|reached)|\b429\b|hit your (?:usage|weekly|5h) limit/i;

// Credential failures (revoked/invalidated tokens) — re-login required, so
// rotation should skip this account and tell the user how to fix it.
const AUTH_RE =
  /refresh[ _]token[ _](?:was )?(?:revoked|invalidated)|token_invalidated|please log ?out and sign in again|please try signing in again|401 unauthorized/i;

function looksAuthFailed(output) {
  return AUTH_RE.test(output || '');
}

function looksRateLimited(output, extraPatterns = []) {
  if (LIMIT_RE.test(output || '')) return true;
  for (const p of extraPatterns) {
    try {
      if (new RegExp(p, 'i').test(output || '')) return true;
    } catch {
      /* invalid user pattern — ignore */
    }
  }
  return false;
}

// Try to extract "try again in 2 hours 30 minutes" style hints; fall back
// to the configured cooldown.
function limitCooldownMs(output, cooldownMinutes) {
  const m = /try again (?:in|after)\s+([^.\n]+)/i.exec(output || '');
  const parsed = m ? parseDurationMs(m[1]) : null;
  return parsed || cooldownMinutes * 60000;
}

module.exports = {
  codexBin,
  spawnCodexSync,
  assertCodexAvailable,
  buildProfile,
  runCodex,
  looksRateLimited,
  looksAuthFailed,
  limitCooldownMs,
  scanUsage,
  recordUsage,
  sessionTouchedSince,
};
