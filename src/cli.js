'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { readJSONSafe, writeJSONAtomic, authInfo, ensureDir, fmtDate, fmtRemaining, table } = require('./util.js');
const store = require('./store.js');
const runner = require('./runner.js');
const ui = require('./ui.js');

const HELP = `codexswitch — multi-account manager for the OpenAI Codex CLI

Run without a command to open the persistent interactive prompt.

Accounts
  login [name]            log in to a new account (isolated "codex login") and store it
  import [name]           import the account currently in ~/.codex/auth.json
  add-key <name> [key]    register an OpenAI API-key account (or read $OPENAI_API_KEY)
  list                    list stored accounts (alias: accounts)
  usage [name]            per-account 5h/weekly usage gauges with reset times
                          (alias: status)
  watch                   live usage dashboard, refreshes every 5s (q to quit)
  probe [name]            warm up quota gauges with a minimal request per
                          account (costs a few tokens; alias: warmup)
  log [count]             recent activity: switches, limits, rotations
  history [count]         work history: request, result, account, duration, files
  history show <id>       full details (use "latest" for the newest run)
  use <name>              make <name> the active account in ~/.codex
  current                 show the active account
  next                    switch to the next account in rotation order (wraps around)
  remove <name>           delete a stored account
  rename <old> <new>      rename a stored account
  enable <name>           re-enable a disabled account
  disable <name>          temporarily exclude an account from rotation
  order [name...]         pin the rotation order in one command; accounts not
                          listed rotate by soonest weekly reset (use-or-lose)
  priority <name> <n|auto>  pin one account's priority, or "auto" to unpin
  clear-limit <name>      forget a recorded rate-limit for an account

Running codex
  chat                    interactive prompt loop (Claude Code-style): each turn
                          runs through rotation and resumes the same session,
                          so the conversation survives account switches
                          (/status /usage /memory /use /next /model /new /quit)
  run [name] [args...]    run codex as <name> (or active account) in an isolated
                          per-account CODEX_HOME; config/sessions are shared
  exec [args...]          run "codex exec ..." and auto-rotate through accounts in
                          rotation order on usage limits; the next account resumes
                          the same session (--skip-git-repo-check added automatically)
      -a, --account <n>   start exec with a specific account
      --no-resume         restart the prompt instead of resuming on rotation
  server [--port N]       EXPERIMENTAL local proxy: per-request account
                          rotation with live usage from response headers
  server status           show whether the local proxy is reachable
  run --proxy [args...]   use proxy when available, otherwise run directly
      --require-proxy     fail instead of falling back when proxy is unavailable

Settings
  model [name|default]    show/set the default model injected into run/exec
  reasoning [mode]        how much model reasoning to print during runs:
                          show (codex default) | concise | hide
  output [mode]           exec/chat display: auto (compact on TTY, raw when
                          piped) | compact (result + summary) | raw
  sandbox [mode]          file access for exec/chat: read-only (codex default)
                          | write (edit files in cwd) | write+net (also allow
                          ssh/curl/network) | full (no sandbox)
  threshold [5h%] [wk%]   rotate early when recorded usage reaches these percents
                          of the 5-hour / weekly window (default 95, one value = both)
  cooldown [minutes]      show/set rate-limit cooldown (default 60)
  patterns [add|remove]   extra regex patterns treated as rate-limit errors
  memory [command]        cross-account memory for exec/chat: status, shared,
                          isolated, off, add <text>, show [account], path [account]

Maintenance
  sync                    save tokens refreshed by codex back into the store
  export <file>           back up all accounts + settings (contains tokens!)
  restore <file>          restore accounts from a backup file
  completion <bash|zsh>   print a shell completion script
  help                    show this help

Anything else is forwarded to codex under the managed account, so commands
like "codexswitch resume", "codexswitch goal ..." or "codexswitch apply"
work exactly like their codex counterparts.

Environment
  CODEX_SWITCH_HOME       data dir (default ~/.codex-switch)
  CODEX_HOME              codex config dir codexswitch manages (default ~/.codex)
  CODEX_SWITCH_CODEX_BIN  path to the codex binary (default "codex" on PATH)`;

function out(msg) {
  console.log(msg);
}

function requireArg(args, i, what) {
  if (args[i] == null) throw new Error(`missing ${what} (see "codexswitch help")`);
  return args[i];
}

function defaultName(auth) {
  const info = authInfo(auth);
  if (!info.email || info.email === '(api key)') {
    throw new Error('could not derive an account name from the token; pass a name explicitly');
  }
  return info.email;
}

function storeAccount(name, auth) {
  store.ensureDirs();
  const info = authInfo(auth);
  if (!info.accountId && !auth.OPENAI_API_KEY) {
    throw new Error('auth.json has neither OAuth tokens nor an API key — refusing to import');
  }
  const existed = store.accountExists(name);
  store.writeAccountAuth(name, auth);
  const meta = store.loadMeta();
  if (!meta.accounts[name]) meta.accounts[name] = { addedAt: Date.now() };
  // fresh credentials fix whatever got the account disabled or limited
  delete meta.accounts[name].disabled;
  delete meta.accounts[name].limitedUntil;
  store.saveMeta(meta);
  out(ui.ok(`${existed ? 'updated' : 'added'} account ${ui.bold(`"${name}"`)}${info.email ? ui.dim(` (${info.email}, ${info.plan || 'unknown plan'})`) : ''}`));
  return name;
}

function cmdImport(args) {
  const p = store.paths();
  const auth = readJSONSafe(p.authPath);
  if (!auth) throw new Error(`no auth.json found at ${p.authPath} — run "codex login" first`);
  const name = args[0] || defaultName(auth);
  storeAccount(name, auth);
  const meta = store.loadMeta();
  if (!meta.active) {
    meta.active = name;
    store.saveMeta(meta);
    out(`set "${name}" as the active account`);
  }
}

function cmdLogin(args) {
  runner.assertCodexAvailable();
  store.ensureDirs();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codexswitch-login-'));
  try {
    out(ui.info('opening codex login in an isolated profile (your current account is untouched)...'));
    const r = runner.spawnCodexSync(['login'], {
      env: { ...process.env, CODEX_HOME: tmp },
      stdio: 'inherit',
    });
    if (r.status !== 0) throw new Error(`codex login exited with status ${r.status}`);
    const auth = readJSONSafe(path.join(tmp, 'auth.json'));
    if (!auth) throw new Error('login finished but no auth.json was produced');
    const name = args[0] || defaultName(auth);
    storeAccount(name, auth);
    const meta = store.loadMeta();
    if (!meta.active) {
      cmdUse([name]);
    } else {
      out(`stored. activate it with: codexswitch use ${name}`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function cmdList() {
  const accounts = store.listAccounts();
  if (accounts.length === 0) {
    printEmptyAccounts();
    return;
  }
  const now = Date.now();
  const meta = store.loadMeta();
  const pct = (win, threshold) => {
    if (!win || typeof win.pct !== 'number') return ui.dim('-');
    const v = `${Math.round(win.pct)}%`;
    return win.pct >= threshold ? ui.red(v) : win.pct >= 70 ? ui.yellow(v) : ui.green(v);
  };
  const rows = accounts.map((a) => {
    const over = store.overThreshold(a, meta, now);
    const status = a.disabled
      ? ui.red('disabled')
      : a.limitedUntil && a.limitedUntil > now
        ? ui.yellow(`paused ${fmtRemaining(a.limitedUntil)}`)
        : over
          ? ui.yellow(`over-${over}`)
          : ui.green('ready');
    return [
      a.active ? ui.green('●') : '',
      a.active ? ui.bold(a.name) : a.name,
      ui.dim(a.email || '-'),
      a.plan,
      a.priority == null ? ui.dim('auto') : a.priority,
      status,
      pct(a.usage && a.usage.p5h, meta.threshold5h),
      pct(a.usage && a.usage.weekly, meta.thresholdWeekly),
      ui.dim(fmtDate(a.lastRefresh)),
    ];
  });
  out(table(rows, ['', 'name', 'email', 'plan', 'prio', 'status', '5h', 'week', 'token refreshed']));
  const ready = accounts.filter((a) => store.isUsable(a, meta, now));
  const next = store.pickAccount();
  out(ui.dim(`\n${ready.length}/${accounts.length} ready · next: ${next ? next.name : 'none'} · threshold: 5h ${meta.threshold5h}% / week ${meta.thresholdWeekly}%`));
  if (!next) out(ui.warn('No account can run now. Check details with "codexswitch usage".'));
}

function printEmptyAccounts() {
  out(ui.bold('No accounts yet'));
  out('  1. Import the account already signed in to Codex:');
  out(`     ${ui.cyan('codexswitch import')}`);
  out('  2. Add another account in an isolated login:');
  out(`     ${ui.cyan('codexswitch login <name>')}`);
  out(ui.dim('\nYour current Codex login is never replaced during step 2.'));
}

function cmdUse(args) {
  const name = requireArg(args, 0, 'account name');
  const auth = store.readAccountAuth(name);
  store.syncBack(); // keep refreshed tokens of the outgoing account
  const p = store.paths();
  ensureDir(p.codexHome);
  writeJSONAtomic(p.authPath, auth, 0o600);
  const meta = store.loadMeta();
  meta.active = name;
  if (!meta.accounts[name]) meta.accounts[name] = {};
  meta.accounts[name].lastUsed = Date.now();
  store.saveMeta(meta);
  store.logEvent('switch', `now using "${name}"`);
  const info = authInfo(auth);
  out(ui.ok(`now using ${ui.bold(`"${name}"`)}${info.email ? ui.dim(` (${info.email}, ${info.plan || 'unknown plan'})`) : ''}`));
}

function cmdCurrent() {
  const meta = store.loadMeta();
  const p = store.paths();
  const live = readJSONSafe(p.authPath);
  if (!live) {
    out(`no auth.json at ${p.authPath}`);
    return;
  }
  const info = authInfo(live);
  const accounts = store.listAccounts();
  const match =
    (info.email && accounts.find((a) => a.email === info.email)) ||
    accounts.find((a) => a.accountId === info.accountId);
  const name = match ? match.name : '(not stored — run "codexswitch import")';
  const note = meta.active && match && meta.active !== match.name ? ui.yellow(` (meta says "${meta.active}" — out of sync)`) : '';
  out(`active: ${ui.bold(name)}${note}`);
  out(ui.dim(`  email: ${info.email || '-'}\n  plan:  ${info.plan || '-'}\n  token refreshed: ${fmtDate(info.lastRefresh)}`));
}

function cmdNext() {
  const next = store.nextAccount();
  if (!next) throw new Error('no other usable account available');
  cmdUse([next.name]);
}

// Register an API-key account (Console/platform billing instead of a
// ChatGPT plan). The key is stored only inside the account's auth.json.
function cmdAddKey(args) {
  const name = requireArg(args, 0, 'account name');
  const key = args[1] || process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error(
      'missing API key: pass it as the second argument or set OPENAI_API_KEY in the environment'
    );
  }
  if (!/^sk-/.test(key)) throw new Error('that does not look like an OpenAI API key (should start with "sk-")');
  storeAccount(name, {
    auth_mode: 'apikey',
    OPENAI_API_KEY: key,
    tokens: null,
    last_refresh: null,
  });
  const meta = store.loadMeta();
  if (!meta.active) cmdUse([name]);
}

function cmdRemove(args) {
  const name = requireArg(args, 0, 'account name');
  if (!store.accountExists(name)) throw new Error(`no such account: ${name}`);
  fs.rmSync(store.accountPath(name), { force: true });
  fs.rmSync(path.join(store.paths().profilesDir, name), { recursive: true, force: true });
  const meta = store.loadMeta();
  delete meta.accounts[name];
  if (meta.active === name) meta.active = null;
  store.saveMeta(meta);
  out(`removed "${name}"`);
}

function cmdRename(args) {
  const from = requireArg(args, 0, 'current name');
  const to = requireArg(args, 1, 'new name');
  const auth = store.readAccountAuth(from);
  if (store.accountExists(to)) throw new Error(`account "${to}" already exists`);
  store.writeAccountAuth(to, auth);
  fs.rmSync(store.accountPath(from), { force: true });
  const oldMemory = store.memoryPath('isolated', from);
  const newMemory = store.memoryPath('isolated', to);
  if (fs.existsSync(oldMemory)) {
    ensureDir(path.dirname(newMemory));
    fs.renameSync(oldMemory, newMemory);
  }
  const meta = store.loadMeta();
  meta.accounts[to] = meta.accounts[from] || { priority: 0 };
  delete meta.accounts[from];
  if (meta.active === from) meta.active = to;
  store.saveMeta(meta);
  out(`renamed "${from}" -> "${to}"`);
}

function setFlag(name, patch) {
  if (!store.accountExists(name)) throw new Error(`no such account: ${name}`);
  const meta = store.loadMeta();
  meta.accounts[name] = { ...(meta.accounts[name] || {}), ...patch };
  store.saveMeta(meta);
}

function cmdPriority(args) {
  const name = requireArg(args, 0, 'account name');
  const value = requireArg(args, 1, 'priority number or "auto"');
  if (value === 'auto') {
    const meta = store.loadMeta();
    if (meta.accounts[name]) delete meta.accounts[name].priority;
    store.saveMeta(meta);
    out(ui.ok(`"${name}" unpinned — rotates by soonest weekly reset (use-or-lose)`));
    return;
  }
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) throw new Error('priority must be a number or "auto"');
  setFlag(name, { priority: n });
  out(ui.ok(`priority of "${name}" pinned to ${n}`));
}

function cmdCooldown(args) {
  const meta = store.loadMeta();
  if (args[0] == null) {
    out(`cooldown: ${meta.cooldownMinutes} minutes`);
    return;
  }
  const n = parseInt(args[0], 10);
  if (Number.isNaN(n) || n <= 0) throw new Error('cooldown must be a positive number of minutes');
  meta.cooldownMinutes = n;
  store.saveMeta(meta);
  out(`cooldown set to ${n} minutes`);
}

function cmdSync() {
  const updated = store.syncBack();
  out(updated ? `synced refreshed tokens into "${updated}"` : 'nothing to sync');
}

// Set the rotation order in one go: listed accounts get priority 0..k-1,
// unlisted accounts follow after in their current order.
function cmdOrder(args) {
  const accounts = store.listAccounts();
  if (args.length === 0) {
    if (accounts.length === 0) {
      out('no accounts yet');
      return;
    }
    accounts.forEach((a, i) => out(`${i + 1}. ${a.name}${a.active ? ' (active)' : ''}`));
    return;
  }
  for (const name of args) {
    if (!store.accountExists(name)) throw new Error(`no such account: ${name}`);
  }
  const dupe = args.find((n, i) => args.indexOf(n) !== i);
  if (dupe) throw new Error(`account listed twice: ${dupe}`);
  const meta = store.loadMeta();
  let prio = 0;
  for (const name of args) {
    meta.accounts[name] = { ...(meta.accounts[name] || {}), priority: prio++ };
  }
  // accounts not listed become "auto" and rotate by soonest weekly reset
  for (const a of accounts) {
    if (args.includes(a.name)) continue;
    if (meta.accounts[a.name]) delete meta.accounts[a.name].priority;
  }
  store.saveMeta(meta);
  out(ui.ok('rotation order set:'));
  store.listAccounts().forEach((a, i) =>
    out(`${i + 1}. ${a.name}${a.priority == null ? ui.dim(' (auto)') : ''}`)
  );
}

function cmdModel(args) {
  const meta = store.loadMeta();
  if (args[0] == null) {
    out(`model: ${meta.model || '(codex default)'}`);
    return;
  }
  if (args[0] === 'default' || args[0] === 'clear') {
    delete meta.model;
    store.saveMeta(meta);
    out('model reset to codex default');
    return;
  }
  meta.model = args[0];
  store.saveMeta(meta);
  out(`default model set to "${meta.model}" (applied to run/exec)`);
}

// Render the per-account usage view (gauge bars for the 5h / weekly windows
// with reset countdowns). `cursor` marks the selected row in watch mode.
function usageLines(accounts, meta, { cursor = -1 } = {}) {
  const now = Date.now();
  const lines = [];
  const usable = accounts.filter((a) => store.isUsable(a, meta, now));
  const active = accounts.find((a) => a.active);
  lines.push(
    `${ui.bold('Usage overview')}  ${ui.green(`${usable.length} ready`)} / ${accounts.length}` +
      `${active ? ui.dim(` · active ${active.name}`) : ''}`
  );
  lines.push('');
  const bar = (pct, threshold) => {
    const width = 20;
    const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
    const paint = pct >= threshold ? ui.red : pct >= 70 ? ui.yellow : ui.green;
    return `[${paint('█'.repeat(filled))}${ui.dim('░'.repeat(width - filled))}]`;
  };
  const gauge = (label, win, threshold) => {
    if (!win || typeof win.pct !== 'number') return `  ${label} ${ui.dim('no data')}`;
    const pct = Math.round(win.pct);
    const reset = win.resetAt && win.resetAt > now ? ` resets in ${fmtRemaining(win.resetAt)}` : '';
    const overMark = win.pct >= threshold ? ` ${ui.red(`≥ threshold ${threshold}%`)}` : '';
    return `  ${label} ${bar(win.pct, threshold)} ${String(pct).padStart(3)}%${ui.dim(reset)}${overMark}`;
  };
  accounts.forEach((a, i) => {
    const sel = i === cursor ? ui.cyan('▶') : ' ';
    const mark = a.active ? ui.green('●') : ' ';
    const state = a.disabled ? ui.red(' [disabled]') : a.limitedUntil && a.limitedUntil > now ? ui.yellow(` [limited ${fmtRemaining(a.limitedUntil)}]`) : '';
    lines.push(`${cursor >= 0 ? sel : ''}${mark} ${ui.bold(a.name)}${ui.dim(` (${a.plan || a.email || '-'})`)}${state}`);
    if (!a.usage) {
      lines.push(ui.dim(`  no usage data yet — measure it with "codexswitch probe ${a.name}"`));
    } else {
      lines.push(gauge('5h    ', a.usage.p5h, meta.threshold5h));
      lines.push(gauge('weekly', a.usage.weekly, meta.thresholdWeekly));
      if (a.usage.at) lines.push(ui.dim(`  measured ${fmtDate(a.usage.at)}`));
    }
  });
  const next = store.pickAccount();
  lines.push(`\n${ui.dim('Next account')}  ${next ? ui.bold(next.name) : ui.red('none usable')}`);
  lines.push(ui.dim(`Thresholds    5h ${meta.threshold5h}% · week ${meta.thresholdWeekly}%`));
  return lines;
}

function cmdUsage(args) {
  const meta = store.loadMeta();
  let accounts = store.listAccounts();
  if (args[0]) {
    accounts = accounts.filter((a) => a.name === args[0]);
    if (accounts.length === 0) throw new Error(`no such account: ${args[0]}`);
  }
  if (accounts.length === 0) {
    printEmptyAccounts();
    return;
  }
  for (const l of usageLines(accounts, meta)) out(l);
}

// Warm up quota measurements: send a minimal request per account so the
// usage gauges (and use-or-lose ordering) have data. Costs a few tokens.
async function cmdProbe(args) {
  runner.assertCodexAvailable();
  const meta = store.loadMeta();
  let accounts = store.listAccounts().filter((a) => !a.disabled);
  if (args[0]) {
    accounts = accounts.filter((a) => a.name === args[0]);
    if (accounts.length === 0) throw new Error(`no such account: ${args[0]}`);
  }
  if (accounts.length === 0) throw new Error('no enabled accounts to probe');
  out(ui.info(ui.dim(`probing ${accounts.length} account(s) with a minimal request...`)));
  let failures = 0;
  for (const a of accounts) {
    const line = await probeOne(a, meta);
    out(line.text);
    if (!line.ok) failures++;
  }
  return failures > 0 ? 1 : 0;
}

// Probe a single account; returns a printable result line.
async function probeOne(a, meta) {
  const startTs = Date.now();
  const res = await runner.runCodex(
    a.name,
    ['exec', ...buildExecArgs(['Reply with exactly: ok'], meta)],
    { capture: true, silent: true }
  );
  const usage = runner.recordUsage(a.name, res.profile, startTs);
  if (res.code !== 0) {
    const why = runner.looksAuthFailed(res.output)
      ? `login revoked — fix with "codexswitch login ${a.name}"`
      : runner.looksRateLimited(res.output, meta.limitPatterns)
        ? 'rate limited'
        : `exit ${res.code}`;
    store.logEvent('probe', `${a.name} failed: ${why}`);
    return { ok: false, text: ui.fail(`${a.name}: ${why}`) };
  }
  store.logEvent('probe', `${a.name} measured`);
  if (usage && usage.p5h) {
    return { ok: true, text: ui.ok(`${a.name}: 5h ${Math.round(usage.p5h.pct)}%${usage.weekly ? ` / weekly ${Math.round(usage.weekly.pct)}%` : ''}`) };
  }
  return { ok: true, text: ui.warn(`${a.name}: reachable, but codex reported no usage data`) };
}

function cmdLog(args) {
  const count = args[0] ? parseInt(args[0], 10) : 20;
  if (Number.isNaN(count) || count < 1) throw new Error('usage: codexswitch log [count]');
  const events = store.readEvents(count);
  if (events.length === 0) {
    out('no activity yet');
    return;
  }
  const color = { limit: ui.yellow, auth: ui.red, probe: ui.cyan, switch: ui.green, exec: ui.green };
  for (const e of events) {
    const paint = color[e.type] || ((s) => s);
    out(`${ui.dim(e.at.replace('T', ' ').slice(0, 19))}  ${paint(e.type.padEnd(6))} ${e.message}`);
  }
}

function shortText(value, max = 56) {
  const oneLine = String(value || '').replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms)) return '-';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
  return `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`;
}

function cmdHistory(args) {
  if (args[0] === 'show') {
    const id = requireArg(args, 1, 'history id (or "latest")');
    const run = store.findRun(id);
    if (!run) throw new Error(`no history entry matching "${id}"`);
    out(`${ui.bold(run.id)}  ${run.status === 'done' ? ui.green('done') : ui.red(run.status)}`);
    out(`${ui.dim('Started')}   ${fmtDate(run.startedAt)}`);
    out(`${ui.dim('Duration')}  ${formatDuration(run.durationMs)}`);
    out(`${ui.dim('Directory')} ${run.cwd || '-'}`);
    out(`${ui.dim('Session')}   ${run.session} · memory ${run.memory} · reasoning ${run.reasoning}`);
    out(`\n${ui.bold('Request')}\n${run.prompt || ui.dim('(not captured)')}`);
    out(`\n${ui.bold('Attempts')}`);
    for (const attempt of run.attempts || []) {
      const paint = attempt.status === 'done' ? ui.green : attempt.status === 'rate-limited' ? ui.yellow : ui.red;
      out(`  ${paint(attempt.status.padEnd(12))} ${attempt.account} · ${formatDuration(attempt.durationMs)}`);
    }
    out(`\n${ui.bold('Files changed during this run')}`);
    if (run.touchedFiles && run.touchedFiles.length) run.touchedFiles.forEach((file) => out(`  ${file}`));
    else out(ui.dim('  no file changes detected'));
    out(`\n${ui.bold('Git workspace after run')}`);
    if (run.files && run.files.length) run.files.forEach((file) => out(`  ${file}`));
    else out(ui.dim('  clean'));
    if (run.promptTruncated) out(ui.warn('\nRequest was truncated to the last 16 KiB in history.'));
    return;
  }
  const count = args[0] == null ? 20 : parseInt(args[0], 10);
  if (Number.isNaN(count) || count < 1 || count > 200) {
    throw new Error('usage: codexswitch history [1-200] | history show <id|latest>');
  }
  const runs = store.readRuns(count);
  if (runs.length === 0) {
    out('no work history yet — exec, run <account> exec, and chat runs appear here');
    return;
  }
  const rows = runs.map((run) => [
    run.id,
    fmtDate(run.startedAt),
    run.status === 'done' ? ui.green('done') : ui.red(run.status),
    (run.attempts || []).map((a) => a.account).join(' → ') || '-',
    formatDuration(run.durationMs),
    shortText(run.prompt),
  ]);
  out(table(rows, ['id', 'started', 'result', 'account flow', 'time', 'request']));
  out(ui.dim('\nFull details: codexswitch history show <id>'));
  out(ui.dim(`Stored locally in ${path.join(store.paths().home, 'history.jsonl')} (contains prompts)`));
}

function workspaceSnapshot() {
  const result = spawnSync('git', ['status', '--short', '--untracked-files=all'], { cwd: process.cwd(), encoding: 'utf8' });
  if (result.status !== 0 || !result.stdout) return {};
  const snapshot = {};
  for (const line of result.stdout.trim().split(/\r?\n/).filter(Boolean).slice(0, 100)) {
    let file = line.slice(3);
    if (file.includes(' -> ')) file = file.split(' -> ').pop();
    if (file.startsWith('"')) {
      try { file = JSON.parse(file); } catch { /* keep Git's displayed path */ }
    }
    try {
      const stat = fs.statSync(path.resolve(file), { bigint: true });
      snapshot[line] = `${stat.size}:${stat.mtimeNs}`;
    } catch {
      snapshot[line] = 'missing';
    }
  }
  return snapshot;
}

function promptFromExecArgs(args) {
  if (!args.length) return '';
  const separator = args.lastIndexOf('--');
  const value = args[args.length - 1];
  if (separator < 0 && String(value).startsWith('-')) return '';
  return String(value);
}

// Live interactive dashboard: usage gauges + recent activity, refreshed
// every 5s. Keyboard: up/down select, s switch, e enable/disable, p probe,
// r refresh, q quit.
async function cmdWatch() {
  if (!process.stdout.isTTY) {
    cmdUsage([]);
    return 0;
  }
  let cursor = 0;
  let message = '';
  let busy = false;
  const render = () => {
    const meta = store.loadMeta();
    const accounts = store.listAccounts();
    if (cursor >= accounts.length) cursor = Math.max(0, accounts.length - 1);
    process.stdout.write('\x1b[2J\x1b[H');
    out(`${ui.bold('codexswitch watch')}${ui.dim(`  ${new Date().toLocaleTimeString()} \u00b7 refreshes every 5s`)}\n`);
    if (accounts.length === 0) {
      out('no accounts yet \u2014 add one with "codexswitch login"');
    } else {
      for (const l of usageLines(accounts, meta, { cursor })) out(l);
    }
    const events = store.readEvents(4);
    if (events.length > 0) {
      out(ui.dim('\nrecent activity:'));
      for (const e of events) out(ui.dim(`  ${e.at.replace('T', ' ').slice(11, 19)}  ${e.type}: ${e.message}`));
    }
    out(`\n${ui.dim('keys:')} ${ui.cyan('\u2191/\u2193')} select  ${ui.cyan('s')} switch  ${ui.cyan('e')} enable/disable  ${ui.cyan('p')} probe  ${ui.cyan('r')} refresh  ${ui.cyan('q')} quit`);
    if (message) out(message);
  };
  render();
  const timer = setInterval(() => {
    if (!busy) render();
  }, 5000);
  await new Promise((resolve) => {
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', async (b) => {
      if (busy) return;
      const s = b.toString();
      const accounts = store.listAccounts();
      const selected = accounts[cursor];
      if (s === 'q' || s === '\u0003') {
        clearInterval(timer);
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
        process.stdin.pause();
        resolve();
        return;
      }
      if (s === '\x1b[A' || s === 'k') cursor = Math.max(0, cursor - 1);
      else if (s === '\x1b[B' || s === 'j') cursor = Math.min(accounts.length - 1, cursor + 1);
      else if (s === 'r') message = '';
      else if (s === 's' && selected) {
        try {
          cmdUse([selected.name]);
          message = ui.ok(`switched to "${selected.name}"`);
        } catch (e) {
          message = ui.fail(e.message);
        }
      } else if (s === 'e' && selected) {
        setFlag(selected.name, { disabled: !selected.disabled });
        message = selected.disabled ? ui.ok(`enabled "${selected.name}"`) : ui.warn(`disabled "${selected.name}"`);
      } else if (s === 'p' && selected) {
        busy = true;
        message = ui.dim(`probing "${selected.name}"...`);
        render();
        try {
          const result = await probeOne(selected, store.loadMeta());
          message = result.text;
        } catch (e) {
          message = ui.fail(e.message);
        }
        busy = false;
      }
      render();
    });
  });
  return 0;
}

// Rotate-early thresholds: how full the 5h / weekly window may get before
// the account is skipped in rotation.
function cmdThreshold(args) {
  const meta = store.loadMeta();
  if (args.length === 0) {
    out(`threshold: 5h ${meta.threshold5h}% / weekly ${meta.thresholdWeekly}%`);
    out('usage: codexswitch threshold <5h%> [weekly%]   (one value sets both)');
    return;
  }
  const parse = (s) => {
    const n = parseInt(s, 10);
    if (Number.isNaN(n) || n < 1 || n > 100) throw new Error(`threshold must be 1-100, got "${s}"`);
    return n;
  };
  meta.threshold5h = parse(args[0]);
  meta.thresholdWeekly = args[1] != null ? parse(args[1]) : meta.threshold5h;
  store.saveMeta(meta);
  out(`threshold set: 5h ${meta.threshold5h}% / weekly ${meta.thresholdWeekly}%`);
}

function cmdPatterns(args) {
  const meta = store.loadMeta();
  const [sub, ...rest] = args;
  if (!sub) {
    out('built-in: usage limit / rate limit / too many requests / quota exceeded / 429');
    if (meta.limitPatterns.length === 0) out('custom: (none)');
    else meta.limitPatterns.forEach((p, i) => out(`custom ${i + 1}: ${p}`));
    return;
  }
  if (sub === 'add') {
    const pattern = rest.join(' ');
    if (!pattern) throw new Error('usage: codexswitch patterns add <regex>');
    new RegExp(pattern, 'i'); // validate — throws on bad regex
    meta.limitPatterns.push(pattern);
    store.saveMeta(meta);
    out(`added pattern: ${pattern}`);
    return;
  }
  if (sub === 'remove') {
    const key = rest.join(' ');
    const idx = /^\d+$/.test(key) ? parseInt(key, 10) - 1 : meta.limitPatterns.indexOf(key);
    if (idx < 0 || idx >= meta.limitPatterns.length) throw new Error(`no such pattern: ${key}`);
    const [removed] = meta.limitPatterns.splice(idx, 1);
    store.saveMeta(meta);
    out(`removed pattern: ${removed}`);
    return;
  }
  throw new Error('usage: codexswitch patterns [add <regex> | remove <n|regex>]');
}

function cmdExport(args) {
  const file = requireArg(args, 0, 'output file path');
  const accounts = {};
  for (const a of store.listAccounts()) accounts[a.name] = store.readAccountAuth(a.name);
  if (Object.keys(accounts).length === 0) throw new Error('no accounts to export');
  writeJSONAtomic(path.resolve(file), { version: 1, exportedAt: new Date().toISOString(), meta: store.loadMeta(), accounts }, 0o600);
  out(`exported ${Object.keys(accounts).length} account(s) to ${file}`);
  out('WARNING: this file contains login tokens — treat it like a password.');
}

function cmdRestore(args) {
  const file = requireArg(args, 0, 'backup file path');
  const data = readJSONSafe(path.resolve(file));
  if (!data || data.version !== 1 || !data.accounts) throw new Error('not a codexswitch backup file');
  store.ensureDirs();
  const meta = store.loadMeta();
  let n = 0;
  for (const [name, auth] of Object.entries(data.accounts)) {
    store.writeAccountAuth(name, auth);
    const backup = (data.meta && data.meta.accounts && data.meta.accounts[name]) || {};
    meta.accounts[name] = { ...backup, ...(meta.accounts[name] || {}) };
    n++;
  }
  if (!meta.active && data.meta && data.meta.active) meta.active = data.meta.active;
  store.saveMeta(meta);
  out(`restored ${n} account(s) from ${file}`);
}

function cmdNames() {
  for (const a of store.listAccounts()) out(a.name);
}

const COMMANDS =
  'login import add-key list usage watch probe log history chat server use current next run exec order model remove rename ' +
  'enable disable priority clear-limit cooldown threshold reasoning output sandbox memory patterns export restore sync completion help';

function cmdCompletion(args) {
  const shell = args[0];
  if (shell !== 'bash' && shell !== 'zsh') {
    throw new Error('usage: codexswitch completion <bash|zsh>  (append the output to your shell rc file)');
  }
  const script = `# codexswitch completion (${shell})
${shell === 'zsh' ? 'autoload -Uz bashcompinit && bashcompinit\n' : ''}_codexswitch() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  if [ "\$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( \$(compgen -W "${COMMANDS}" -- "\$cur") )
  else
    COMPREPLY=( \$(compgen -W "\$(codexswitch names 2>/dev/null)" -- "\$cur") )
  fi
}
complete -F _codexswitch codexswitch cxs`;
  out(script);
}

// Final argv for "codex exec": inject --skip-git-repo-check so it works in
// non-git folders, and the configured default model — unless the user
// already passed their own flags.
function buildExecArgs(rest, meta) {
  // "exec resume [--last|<id>] ..." — the subcommand and its target must
  // stay in front; flags are injected after them.
  if (rest[0] === 'resume') {
    const head = ['resume'];
    let i = 1;
    if (rest[i] === '--last' || (rest[i] && /^[0-9a-f][0-9a-f-]{7,}$/i.test(rest[i]))) head.push(rest[i++]);
    return [...head, ...injectExecFlags(rest.slice(i), meta)];
  }
  return injectExecFlags(rest, meta);
}

function injectExecFlags(rest, meta) {
  const args = [...rest];
  if (!args.includes('--skip-git-repo-check')) args.unshift('--skip-git-repo-check');
  const hasModel = args.some((a) => a === '-m' || a === '--model' || a.startsWith('--model='));
  if (meta.model && !hasModel) args.unshift('-m', meta.model);
  const hasSandbox = args.some(
    (a) =>
      a === '--sandbox' ||
      a.startsWith('--sandbox=') ||
      a === '--full-auto' ||
      a === '--dangerously-bypass-approvals-and-sandbox'
  );
  if (meta.sandbox && !hasSandbox) {
    if (meta.sandbox === 'workspace-write+net') {
      // workspace-write plus outbound network (ssh, curl, npm install...)
      args.unshift('--sandbox', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=true');
    } else {
      args.unshift('--sandbox', meta.sandbox);
    }
  }
  args.unshift(...reasoningFlags(meta, args));
  return args;
}

const SANDBOX_MODES = {
  'read-only': 'read-only',
  write: 'workspace-write',
  'workspace-write': 'workspace-write',
  'write+net': 'workspace-write+net',
  net: 'workspace-write+net',
  full: 'danger-full-access',
  'danger-full-access': 'danger-full-access',
};

// codex exec defaults to a read-only sandbox; this setting lets it write.
function cmdSandbox(args) {
  const meta = store.loadMeta();
  if (args[0] == null) {
    out(`sandbox: ${meta.sandbox || 'read-only (codex exec default)'} ${ui.dim('(read-only | write | full)')}`);
    return;
  }
  if (args[0] === 'read-only' || args[0] === 'default') {
    delete meta.sandbox;
    store.saveMeta(meta);
    out(ui.ok('sandbox back to codex default (read-only in exec)'));
    return;
  }
  const mode = SANDBOX_MODES[args[0]];
  if (!mode) throw new Error('usage: codexswitch sandbox <read-only|write|write+net|full>');
  meta.sandbox = mode;
  store.saveMeta(meta);
  const messages = {
    'workspace-write': ui.ok('sandbox set to workspace-write — codex can edit files in the working directory'),
    'workspace-write+net': ui.ok('sandbox set to workspace-write + network — codex can also use ssh/curl/npm'),
    'danger-full-access': ui.warn('sandbox set to danger-full-access — codex can touch anything, use with care'),
  };
  out(messages[mode]);
}

// -c overrides implementing "cxs reasoning hide|concise|show".
function reasoningFlags(meta, existing = []) {
  if (!meta.reasoning || meta.reasoning === 'show') return [];
  if (existing.some((a) => /hide_agent_reasoning|model_reasoning_summary/.test(a))) return [];
  if (meta.reasoning === 'hide') return ['-c', 'hide_agent_reasoning=true'];
  return ['-c', 'model_reasoning_summary=concise']; // 'concise'
}

function cmdReasoning(args) {
  const meta = store.loadMeta();
  if (args[0] == null) {
    out(`reasoning: ${meta.reasoning || 'show'} ${ui.dim('(show | concise | hide)')}`);
    return;
  }
  const value = args[0];
  if (!['show', 'concise', 'hide'].includes(value)) {
    throw new Error('usage: codexswitch reasoning <show|concise|hide>');
  }
  if (value === 'show') delete meta.reasoning;
  else meta.reasoning = value;
  store.saveMeta(meta);
  out(
    ui.ok(
      value === 'hide'
        ? 'reasoning output hidden (hide_agent_reasoning=true)'
        : value === 'concise'
          ? 'reasoning output shortened (model_reasoning_summary=concise)'
          : 'reasoning output back to codex default'
    )
  );
}

function cmdOutput(args) {
  const meta = store.loadMeta();
  if (args[0] == null) {
    out(`output: ${meta.outputMode || 'auto'} ${ui.dim('(auto | compact | raw)')}`);
    out(ui.dim('auto uses compact output in a terminal and raw output when piped'));
    return;
  }
  const mode = args[0];
  if (!['auto', 'compact', 'raw'].includes(mode)) throw new Error('usage: codexswitch output <auto|compact|raw>');
  if (mode === 'auto') delete meta.outputMode;
  else meta.outputMode = mode;
  store.saveMeta(meta);
  out(ui.ok(`output set to ${mode}`));
}

function compactOutputEnabled(meta) {
  const mode = meta.outputMode || 'auto';
  return mode === 'compact' || (mode === 'auto' && process.stdout.isTTY);
}

function outputFileArg(args, file) {
  if (args.some((a) => a === '-o' || a === '--output-last-message' || a.startsWith('--output-last-message='))) return args;
  const result = [...args];
  const resumeOffset = result[0] === 'resume' ? (result[1] === '--last' || /^[0-9a-f][0-9a-f-]{7,}$/i.test(result[1] || '') ? 2 : 1) : 0;
  result.splice(resumeOffset, 0, '--output-last-message', file);
  return result;
}

function existingOutputFile(args) {
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '-o' || args[i] === '--output-last-message') && args[i + 1]) return path.resolve(args[i + 1]);
    if (args[i].startsWith('--output-last-message=')) return path.resolve(args[i].slice(args[i].indexOf('=') + 1));
  }
  return null;
}

function startCompactProgress(account, attempt, session) {
  const started = Date.now();
  const label = () => `Working · ${account} · ${session} session · ${Math.round((Date.now() - started) / 1000)}s`;
  if (!process.stdout.isTTY) {
    out(ui.info(label()));
    return () => {};
  }
  const draw = () => process.stderr.write(`\r\x1b[2K${ui.cyan('●')} ${label()}`);
  draw();
  const timer = setInterval(draw, 1000);
  return () => {
    clearInterval(timer);
    process.stderr.write('\r\x1b[2K');
  };
}

function printCompactResult(message, run) {
  out(`\n${ui.bold(ui.green('Result'))}`);
  out(ui.dim('─'.repeat(48)));
  out((message || '').trim() || ui.dim('(Codex returned no final message)'));
  out(`\n${ui.bold('Work summary')}`);
  out(ui.dim('─'.repeat(48)));
  out(`${ui.green('✓')} ${run.status} · ${formatDuration(run.durationMs)} · ${(run.attempts || []).map((a) => a.account).join(' → ')}`);
  if (run.touchedFiles && run.touchedFiles.length) {
    out(`${ui.dim('Changed')} ${run.touchedFiles.length} file(s)`);
    run.touchedFiles.slice(0, 12).forEach((file) => out(`  ${file}`));
    if (run.touchedFiles.length > 12) out(ui.dim(`  … and ${run.touchedFiles.length - 12} more`));
  } else {
    out(ui.dim('Changed 0 files'));
  }
}

function memoryTarget(meta, requestedAccount = null) {
  if (meta.memoryMode !== 'isolated') return null;
  const picked = store.pickAccount();
  const name = requestedAccount || meta.active || (picked && picked.name);
  if (!name || !store.accountExists(name)) throw new Error('isolated memory needs a valid account (activate one with "codexswitch use")');
  return name;
}

function cmdMemory(args) {
  const meta = store.loadMeta();
  const sub = args[0];
  if (!sub || sub === 'status') {
    const mode = meta.memoryMode || 'off';
    const account = mode === 'isolated' ? memoryTarget(meta) : null;
    const file = mode === 'off' ? null : store.memoryPath(mode, account);
    const size = file ? Buffer.byteLength(store.readMemory(mode, account), 'utf8') : 0;
    out(`memory: ${ui.bold(mode)}${account ? ` · account ${ui.bold(account)}` : ''}`);
    out(ui.dim(file ? `  ${size} bytes · ${file}` : '  disabled · existing Codex session files are still shared'));
    if (mode === 'off') out(`  Enable: ${ui.cyan('codexswitch memory shared')} ${ui.dim('(shared across accounts)')}`);
    return;
  }
  if (['shared', 'isolated', 'off'].includes(sub)) {
    meta.memoryMode = sub;
    store.saveMeta(meta);
    if (sub === 'shared') out(ui.ok('shared memory enabled for exec/chat — all accounts read the same memory file'));
    else if (sub === 'isolated') out(ui.ok('isolated memory enabled — each account reads only its own memory file'));
    else out(ui.ok('memory injection disabled — stored memory files were kept'));
    if (sub !== 'off') out(ui.dim(`add a note: codexswitch memory add "your note"`));
    return;
  }
  const mode = meta.memoryMode || 'off';
  if (mode === 'off') throw new Error('memory is off — choose "codexswitch memory shared" or "memory isolated" first');
  if (sub === 'add') {
    const account = memoryTarget(meta);
    const text = args.slice(1).join(' ');
    const file = store.appendMemory(mode, account, text);
    out(ui.ok(`memory added${account ? ` for "${account}"` : ''}`));
    out(ui.dim(file));
    return;
  }
  if (sub === 'show') {
    const target = memoryTarget(meta, args[1]);
    const text = store.readMemory(mode, target);
    out(text || ui.dim('(memory is empty)'));
    return;
  }
  if (sub === 'path') {
    out(store.memoryPath(mode, memoryTarget(meta, args[1])));
    return;
  }
  throw new Error('usage: codexswitch memory [status|shared|isolated|off|add <text>|show [account]|path [account]]');
}

function withMemoryPrompt(args, accountName, meta) {
  const mode = meta.memoryMode || 'off';
  if (mode === 'off') return args;
  const memory = store.readMemory(mode, mode === 'isolated' ? accountName : null).trim();
  if (!memory) return args;
  const result = [...args];
  const separator = result.lastIndexOf('--');
  const promptIndex = separator >= 0 && separator < result.length - 1
    ? result.length - 1
    : result.length > 0 && !String(result[result.length - 1]).startsWith('-')
      ? result.length - 1
      : -1;
  if (promptIndex < 0) return result;
  result[promptIndex] =
    `<codexswitch-memory mode="${mode}">\n${memory}\n</codexswitch-memory>\n\n` +
    `<user-request>\n${result[promptIndex]}\n</user-request>`;
  return result;
}

// EXPERIMENTAL: foreground proxy server for per-request rotation.
async function cmdServer(args) {
  const proxy = require('./proxy.js');
  if (args[0] === 'status') {
    const state = readJSONSafe(path.join(store.paths().home, 'proxy.json'));
    const port = (state && state.port) || proxy.DEFAULT_PORT;
    const running = await proxy.ping(port);
    out(running ? ui.ok(`proxy running on http://127.0.0.1:${port}`) : ui.warn(`proxy not reachable on port ${port}`));
    out(ui.dim(running ? `${store.listAccounts().length} account(s) available · per-request rotation active` : '"codexswitch run --proxy" will fall back to direct mode'));
    return 0;
  }
  let port = proxy.DEFAULT_PORT;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' || args[i] === '-p') port = parseInt(args[++i], 10);
  }
  if (Number.isNaN(port) || port < 1 || port > 65535) throw new Error('invalid port');
  if (store.listAccounts().length === 0) throw new Error('no accounts — add one with "codexswitch login"');
  const log = (type, msg) => {
    const paint = { rotate: ui.warn, error: ui.fail, ws: ui.info, req: (s) => ui.dim(`  ${s}`) }[type] || ui.info;
    out(paint(msg));
  };
  const server = await proxy.startServer({ port, log });
  const stateFile = path.join(store.paths().home, 'proxy.json');
  writeJSONAtomic(stateFile, { port, pid: process.pid, startedAt: Date.now() });
  out(`${ui.bold('codexswitch proxy')} ${ui.yellow('(experimental)')} listening on ${ui.cyan(`http://127.0.0.1:${port}`)}`);
  out(ui.dim('per-request account rotation · 429 retries on the next account · live usage from response headers'));
  out(ui.dim(`use it with:  codexswitch run --proxy    (Ctrl-C to stop)\n`));
  await new Promise((resolve) => {
    const stop = () => {
      server.close();
      fs.rmSync(stateFile, { force: true });
      resolve();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
  return 0;
}

async function cmdRun(args) {
  store.syncBack(); // pick up tokens refreshed by plain codex before overlaying
  let proxyPort = null;
  const requireProxy = args.includes('--require-proxy');
  args = args.filter((a) => a !== '--require-proxy');
  if (args.includes('--proxy')) {
    const proxy = require('./proxy.js');
    args = args.filter((a) => a !== '--proxy');
    const state = readJSONSafe(path.join(store.paths().home, 'proxy.json'));
    proxyPort = (state && state.port) || proxy.DEFAULT_PORT;
    if (!(await proxy.ping(proxyPort))) {
      if (requireProxy) throw new Error(`no proxy on port ${proxyPort} — start it first with "codexswitch server"`);
      out(ui.warn(`proxy unavailable on port ${proxyPort} — running directly with the selected account`));
      out(ui.dim('use --require-proxy to fail instead of falling back'));
      proxyPort = null;
    }
  }
  let name = null;
  let rest = args;
  if (args[0] && store.accountExists(args[0])) {
    name = args[0];
    rest = args.slice(1);
  }
  if (!name) {
    const meta = store.loadMeta();
    const picked = store.pickAccount();
    if (!picked) throw new Error('no usable account — add one with "codexswitch login"');
    name = meta.active && store.accountExists(meta.active) ? meta.active : picked.name;
  }
  if (rest[0] === '--') rest = rest.slice(1);
  const rawExecArgs = rest[0] === 'exec' ? rest.slice(1) : null;
  const meta = store.loadMeta();
  if (rest[0] === 'exec') {
    rest = ['exec', ...buildExecArgs(withMemoryPrompt(rest.slice(1), name, meta), meta)];
  } else if (rest.length === 0) {
    // interactive TUI launch — apply the same defaults
    if (meta.model) rest = ['-m', meta.model];
    rest = [...reasoningFlags(meta), ...rest];
  }
  out(ui.info(`running codex as ${ui.bold(`"${name}"`)}${proxyPort ? ui.dim(` via proxy :${proxyPort}`) : ''}`));
  const startTs = Date.now();
  const before = rawExecArgs ? workspaceSnapshot() : null;
  const res = await runner.runCodex(name, rest, { proxyPort });
  runner.recordUsage(name, res.profile, startTs);
  if (rawExecArgs) {
    const rawPrompt = promptFromExecArgs(rawExecArgs);
    const after = workspaceSnapshot();
    const id = `${startTs.toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
    store.logRun({
      id,
      startedAt: startTs,
      cwd: process.cwd(),
      prompt: rawPrompt.length > 16384 ? rawPrompt.slice(-16384) : rawPrompt,
      promptTruncated: rawPrompt.length > 16384,
      session: rawExecArgs[0] === 'resume' ? 'continue' : 'new',
      memory: meta.memoryMode || 'off',
      reasoning: meta.reasoning || 'show',
      status: res.code === 0 ? 'done' : `failed-${res.code}`,
      durationMs: Date.now() - startTs,
      attempts: [{ account: name, status: res.code === 0 ? 'done' : `exit-${res.code}`, durationMs: Date.now() - startTs }],
      files: Object.keys(after),
      touchedFiles: Object.keys({ ...before, ...after }).filter((file) => before[file] !== after[file]),
    });
    console.error(ui.info(ui.dim(`history ${id} · view: codexswitch history show ${id}`)));
  }
  return res.code;
}

const RESUME_PROMPT = 'Continue the previous task from exactly where it left off.';

async function cmdExec(args) {
  let explicit = null;
  let allowResume = true;
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-a' || args[i] === '--account') {
      explicit = requireArg(args, ++i, 'account name after --account');
    } else if (args[i] === '--no-resume') {
      allowResume = false;
    } else {
      rest.push(args[i]);
    }
  }
  if (explicit && !store.accountExists(explicit)) throw new Error(`no such account: ${explicit}`);
  if (rest[0] === 'resume') allowResume = false; // user drives resume themselves

  // A prompt like "- item one ..." would be parsed as an option by codex;
  // if the last argument starts with "-" but contains whitespace it can only
  // be a prompt, so protect it with a "--" separator.
  if (!rest.includes('--')) {
    const last = rest[rest.length - 1];
    if (last && /^-/.test(last) && /\s/.test(last)) rest.splice(rest.length - 1, 0, '--');
  }

  store.syncBack(); // pick up tokens refreshed by plain codex before overlaying
  const meta = store.loadMeta();
  const sessionMode = rest[0] === 'resume' ? 'continue' : 'new';
  const reasoningMode = meta.reasoning || 'show';
  const compact = compactOutputEnabled(meta);
  const userOutputFile = existingOutputFile(rest);
  const lastMessageFile = userOutputFile || path.join(os.tmpdir(), `codexswitch-result-${process.pid}-${Date.now()}.txt`);
  const cleanupResult = () => {
    if (!userOutputFile) fs.rmSync(lastMessageFile, { force: true });
  };
  const total = store.listAccounts().length;
  if (total === 0) throw new Error('no accounts — add one with "codexswitch login"');

  const historyStarted = Date.now();
  const rawPrompt = promptFromExecArgs(rest);
  const promptTruncated = rawPrompt.length > 16384;
  const runRecord = {
    id: `${historyStarted.toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
    startedAt: historyStarted,
    cwd: process.cwd(),
    prompt: promptTruncated ? rawPrompt.slice(-16384) : rawPrompt,
    promptTruncated,
    session: sessionMode,
    memory: meta.memoryMode || 'off',
    reasoning: reasoningMode,
    status: 'running',
    attempts: [],
    workspaceBefore: workspaceSnapshot(),
  };
  const finishHistory = (status) => {
    runRecord.status = status;
    runRecord.durationMs = Date.now() - historyStarted;
    const after = workspaceSnapshot();
    runRecord.files = Object.keys(after);
    runRecord.touchedFiles = Object.keys({ ...runRecord.workspaceBefore, ...after }).filter(
      (file) => runRecord.workspaceBefore[file] !== after[file]
    );
    delete runRecord.workspaceBefore;
    store.logRun(runRecord);
  };

  const tried = [];
  let useResume = false;
  for (let attempt = 0; attempt < total; attempt++) {
    let name;
    if (explicit && attempt === 0) {
      name = explicit;
    } else {
      const picked = store.pickAccount(tried);
      if (!picked) break;
      name = picked.name;
    }
    tried.push(name);
    if (!compact) {
      console.error(
        ui.info(
          `account ${ui.bold(`"${name}"`)}${ui.dim(` · session ${useResume || sessionMode === 'continue' ? 'continue' : 'new'} · reasoning ${reasoningMode}`)}` +
            `${ui.dim(attempt > 0 ? ` · attempt ${attempt + 1}` : '')}`
        )
      );
    }
    // On rotation, continue the same session with the next account instead
    // of restarting the whole prompt — the session files are shared.
    const memoryArgs = useResume
      ? withMemoryPrompt(['resume', '--last', '--', RESUME_PROMPT], name, meta)
      : withMemoryPrompt(rest, name, meta);
    const displayArgs = compact ? outputFileArg(memoryArgs, lastMessageFile) : memoryArgs;
    const codexArgs = ['exec', ...buildExecArgs(displayArgs, meta)];
    const startTs = Date.now();
    const stopProgress = compact
      ? startCompactProgress(name, attempt + 1, useResume || sessionMode === 'continue' ? 'continued' : 'new')
      : () => {};
    const res = await runner.runCodex(name, codexArgs, { capture: true, silent: compact });
    stopProgress();
    runner.recordUsage(name, res.profile, startTs);
    if (res.code === 0) {
      runRecord.attempts.push({ account: name, status: 'done', durationMs: Date.now() - startTs });
      store.clearLimited(name);
      if (!compact) console.error(ui.ok(`done as ${ui.bold(`"${name}"`)}`));
      store.logEvent('exec', `done as "${name}"${useResume ? ' (resumed session)' : ''}`);
      warnIfOverThreshold(name);
      finishHistory('done');
      if (compact) {
        const finalMessage = (() => {
          try { return fs.readFileSync(lastMessageFile, 'utf8'); } catch { return ''; }
        })();
        printCompactResult(finalMessage, runRecord);
      }
      cleanupResult();
      console.error(ui.info(ui.dim(`history ${runRecord.id} · view: codexswitch history show ${runRecord.id}`)));
      return 0;
    }
    if (runner.looksRateLimited(res.output, meta.limitPatterns)) {
      runRecord.attempts.push({ account: name, status: 'rate-limited', durationMs: Date.now() - startTs });
      const until = Date.now() + runner.limitCooldownMs(res.output, meta.cooldownMinutes);
      store.markLimited(name, until);
      if (allowResume && !useResume && runner.sessionTouchedSince(res.profile, startTs)) {
        useResume = true;
      }
      console.error(
        ui.warn(`"${name}" hit a usage/rate limit (paused until ${fmtDate(until)}) — rotating${useResume ? ' and resuming the session' : ''}`)
      );
      store.logEvent('limit', `"${name}" paused until ${fmtDate(until)}`);
      continue;
    }
    if (runner.looksAuthFailed(res.output)) {
      runRecord.attempts.push({ account: name, status: 'auth-failed', durationMs: Date.now() - startTs });
      // A revoked token won't heal by itself — take the account out of
      // rotation and keep the task going on the next one.
      setFlag(name, { disabled: true });
      console.error(
        ui.fail(`"${name}" has a revoked/invalid login — disabled. Fix it with: ${ui.bold(`codexswitch login ${name}`)}`)
      );
      store.logEvent('auth', `"${name}" disabled (revoked login)`);
      continue;
    }
    runRecord.attempts.push({ account: name, status: `exit-${res.code}`, durationMs: Date.now() - startTs });
    finishHistory(`failed-${res.code}`);
    if (compact) {
      console.error(ui.fail('Codex failed'));
      console.error(res.output.trim().split(/\r?\n/).slice(-12).join('\n'));
    }
    cleanupResult();
    return res.code; // real failure, don't burn other accounts on it
  }
  console.error(ui.fail('all accounts are rate-limited, over threshold, or disabled'));
  finishHistory('exhausted');
  cleanupResult();
  console.error(ui.info(ui.dim(`history ${runRecord.id} · view: codexswitch history show ${runRecord.id}`)));
  return 2;
}

// Interactive chat: a Claude Code-style prompt loop on top of exec.
// Every turn goes through the rotation engine, and turns 2+ resume the same
// codex session — so the conversation continues even when the account under
// it changes between (or during) turns.
async function cmdChat() {
  const readline = require('readline');
  runner.assertCodexAvailable();
  if (store.listAccounts().length === 0) {
    throw new Error('no accounts — add one with "codexswitch login"');
  }
  const chatStatus = () => {
    const currentMeta = store.loadMeta();
    const active = store.listAccounts().find((a) => a.active);
    const next = store.pickAccount();
    return `model ${currentMeta.model || 'default'} · reasoning ${currentMeta.reasoning || 'show'} · output ${currentMeta.outputMode || 'auto'} · memory ${currentMeta.memoryMode || 'off'} · account ${(active && active.name) || (next && next.name) || 'none'}`;
  };
  out(`${ui.bold('codexswitch chat')} ${ui.dim(`· ${chatStatus()}`)}`);
  out(ui.dim('Enter sends · /paste starts multiline input · /help lists commands\n'));

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.setPrompt(ui.enabled ? `${ui.cyan('cxs')} ${ui.dim('›')} ` : 'cxs › ');
  // Buffer lines ourselves: input can arrive while a turn is still running
  // (type-ahead, piped input) and must not be dropped or hit a closed rl.
  const pending = [];
  const waiters = [];
  let closed = false;
  rl.on('line', (l) => {
    const w = waiters.shift();
    if (w) w(l);
    else pending.push(l);
  });
  rl.on('close', () => {
    closed = true;
    for (const w of waiters.splice(0)) w(null);
  });
  const ask = () => {
    if (pending.length > 0) return Promise.resolve(pending.shift());
    if (closed) return Promise.resolve(null);
    rl.prompt();
    return new Promise((resolve) => waiters.push(resolve));
  };

  let inSession = false;
  let turn = 0;
  for (;;) {
    const raw = await ask();
    if (raw == null) break; // EOF (Ctrl-D or piped input ended)
    const line = raw.trim();
    if (!line) continue;

    if (line[0] === '/') {
      const [cmd, ...rest] = line.slice(1).split(/\s+/);
      try {
        if (cmd === 'quit' || cmd === 'exit' || cmd === 'q') break;
        else if (cmd === 'help')
          out(ui.dim('/status /history [id] /usage /list /use <name> /next /model [m] /sandbox [mode] /reasoning [mode] /output [mode] /memory [command] /paste /new /quit'));
        else if (cmd === 'status') out(ui.info(chatStatus()));
        else if (cmd === 'history') cmdHistory(rest.length ? ['show', rest[0]] : []);
        else if (cmd === 'usage') cmdUsage([]);
        else if (cmd === 'list') cmdList();
        else if (cmd === 'use') cmdUse(rest);
        else if (cmd === 'next') cmdNext();
        else if (cmd === 'model') cmdModel(rest);
        else if (cmd === 'sandbox') cmdSandbox(rest);
        else if (cmd === 'reasoning') cmdReasoning(rest);
        else if (cmd === 'output') cmdOutput(rest);
        else if (cmd === 'memory') cmdMemory(rest);
        else if (cmd === 'new') {
          inSession = false;
          turn = 0;
          out(ui.ok('starting a fresh session on the next prompt'));
        } else if (cmd === 'paste' || cmd === 'multiline') {
          out(ui.info('multiline input · finish with /end on its own line · cancel with /cancel'));
          const parts = [];
          for (;;) {
            const pasted = await ask();
            if (pasted == null || pasted.trim() === '/cancel') {
              parts.length = 0;
              out(ui.warn('multiline input cancelled'));
              break;
            }
            if (pasted.trim() === '/end') break;
            parts.push(pasted);
          }
          if (parts.length > 0) {
            const prompt = parts.join('\n');
            turn++;
            out(ui.info(`turn ${turn} · ${inSession ? 'continuing session' : 'new session'} · ${prompt.split('\n').length} lines`));
            const code = await cmdExec(inSession ? ['resume', '--last', '--', prompt] : ['--', prompt]);
            if (code === 0) inSession = true;
            else if (code === 2) out(ui.fail('all accounts exhausted — try again later or /use a specific account'));
          }
        } else out(ui.warn(`unknown command /${cmd} — try /help`));
      } catch (e) {
        out(ui.fail(e.message));
      }
      continue;
    }

    // "--" marks the prompt as positional so lines starting with "-" are
    // never parsed as codex options.
    turn++;
    out(ui.info(`turn ${turn} · ${inSession ? 'continuing session' : 'new session'}`));
    const code = await cmdExec(inSession ? ['resume', '--last', '--', line] : ['--', line]);
    if (code === 0) inSession = true;
    else if (code === 2) out(ui.fail('all accounts exhausted — try again later or /use a specific account'));
  }
  rl.close();
  out(ui.dim(`\nsession ended · ${turn} turn${turn === 1 ? '' : 's'}${turn > 0 ? ' · review with "codexswitch history"' : ''}`));
  return 0;
}

function warnIfOverThreshold(name) {
  const meta = store.loadMeta();
  const account = store.listAccounts().find((a) => a.name === name);
  if (!account) return;
  const blocked = store.overThreshold(account, meta);
  if (blocked) {
    const pct = blocked === '5h' ? account.usage.p5h.pct : account.usage.weekly.pct;
    console.error(
      ui.warn(`"${name}" is at ${Math.round(pct)}% of its ${blocked} limit (threshold ${blocked === '5h' ? meta.threshold5h : meta.thresholdWeekly}%) — the next exec will rotate to another account`)
    );
  }
}

async function main(argv) {
  const [cmd, ...args] = argv;
  switch (cmd) {
    case undefined:
      if (store.listAccounts().length === 0) {
        printEmptyAccounts();
        return 0;
      }
      return cmdChat();
    case 'help':
    case '--help':
    case '-h':
      out(
        HELP.replace(/^(codexswitch)(?= —)/, ui.bold('$1')).replace(
          /^(Accounts|Running codex|Settings|Maintenance|Environment)$/gm,
          (s) => ui.bold(ui.cyan(s))
        )
      );
      return 0;
    case 'login':
      return cmdLogin(args), 0;
    case 'import':
      return cmdImport(args), 0;
    case 'list':
    case 'accounts':
      return cmdList(), 0;
    case 'usage':
    case 'status':
      return cmdUsage(args), 0;
    case 'watch':
    case 'dashboard':
      return cmdWatch();
    case 'probe':
    case 'warmup':
      return cmdProbe(args);
    case 'log':
    case 'activity':
      return cmdLog(args), 0;
    case 'history':
    case 'work':
      return cmdHistory(args), 0;
    case 'use':
      return cmdUse(args), 0;
    case 'current':
    case 'whoami':
      return cmdCurrent(), 0;
    case 'next':
      return cmdNext(), 0;
    case 'remove':
    case 'rm':
      return cmdRemove(args), 0;
    case 'rename':
      return cmdRename(args), 0;
    case 'enable':
      setFlag(requireArg(args, 0, 'account name'), { disabled: false });
      out(`enabled "${args[0]}"`);
      return 0;
    case 'disable':
      setFlag(requireArg(args, 0, 'account name'), { disabled: true });
      out(`disabled "${args[0]}"`);
      return 0;
    case 'priority':
      return cmdPriority(args), 0;
    case 'order':
      return cmdOrder(args), 0;
    case 'model':
      return cmdModel(args), 0;
    case 'reasoning':
      return cmdReasoning(args), 0;
    case 'output':
      return cmdOutput(args), 0;
    case 'sandbox':
      return cmdSandbox(args), 0;
    case 'memory':
      return cmdMemory(args), 0;
    case 'add-key':
    case 'apikey':
      return cmdAddKey(args), 0;
    case 'threshold':
      return cmdThreshold(args), 0;
    case 'patterns':
      return cmdPatterns(args), 0;
    case 'export':
      return cmdExport(args), 0;
    case 'restore':
      return cmdRestore(args), 0;
    case 'names':
      return cmdNames(), 0;
    case 'completion':
      return cmdCompletion(args), 0;
    case 'clear-limit': {
      const name = requireArg(args, 0, 'account name');
      store.clearLimited(name, { includeUsage: true });
      out(`cleared rate-limit and usage records for "${name}"`);
      return 0;
    }
    case 'cooldown':
      return cmdCooldown(args), 0;
    case 'sync':
      return cmdSync(), 0;
    case 'run':
      return cmdRun(args);
    case 'exec':
      return cmdExec(args);
    case 'chat':
    case 'repl':
      return cmdChat();
    case 'server':
    case 'proxy':
      return cmdServer(args);
    default:
      // Forward everything else to codex under the managed account, so
      // codexswitch is a drop-in replacement: "cxs goal", "cxs resume", ...
      console.error(ui.info(ui.dim(`forwarding to codex: codex ${argv.join(' ')}`)));
      return cmdRun(argv);
  }
}

module.exports = { main };
