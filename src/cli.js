'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { readJSONSafe, writeJSONAtomic, authInfo, ensureDir, fmtDate, fmtRemaining, table } = require('./util.js');
const store = require('./store.js');
const runner = require('./runner.js');

const HELP = `codexswitch — multi-account manager for the OpenAI Codex CLI

Accounts
  login [name]            log in to a new account (isolated "codex login") and store it
  import [name]           import the account currently in ~/.codex/auth.json
  add-key <name> [key]    register an OpenAI API-key account (or read $OPENAI_API_KEY)
  list                    list stored accounts (alias: accounts, status)
  use <name>              make <name> the active account in ~/.codex
  current                 show the active account
  next                    switch to the next account in rotation order (wraps around)
  remove <name>           delete a stored account
  rename <old> <new>      rename a stored account
  enable <name>           re-enable a disabled account
  disable <name>          temporarily exclude an account from rotation
  order [name...]         show or set the rotation order in one command
  priority <name> <n>     set one account's priority (lower = preferred, default 0)
  clear-limit <name>      forget a recorded rate-limit for an account

Running codex
  run [name] [args...]    run codex as <name> (or active account) in an isolated
                          per-account CODEX_HOME; config/sessions are shared
  exec [args...]          run "codex exec ..." and auto-rotate through accounts in
                          rotation order when a usage/rate limit is hit
                          (--skip-git-repo-check is added automatically)
      -a, --account <n>   start exec with a specific account

Settings
  model [name|default]    show/set the default model injected into run/exec
  cooldown [minutes]      show/set rate-limit cooldown (default 60)

Maintenance
  sync                    save tokens refreshed by codex back into the store
  help                    show this help

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
  if (!meta.accounts[name]) meta.accounts[name] = { priority: 0, addedAt: Date.now() };
  store.saveMeta(meta);
  out(`${existed ? 'updated' : 'added'} account "${name}"${info.email ? ` (${info.email}, ${info.plan || 'unknown plan'})` : ''}`);
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
    out('opening codex login in an isolated profile (your current account is untouched)...');
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
    out('no accounts yet — add one with "codexswitch login" or "codexswitch import"');
    return;
  }
  const now = Date.now();
  const rows = accounts.map((a) => [
    a.active ? '*' : '',
    a.name,
    a.email,
    a.plan,
    a.priority,
    a.disabled ? 'disabled' : a.limitedUntil && a.limitedUntil > now ? `limited ${fmtRemaining(a.limitedUntil)}` : 'ok',
    fmtDate(a.lastRefresh),
  ]);
  out(table(rows, ['', 'name', 'email', 'plan', 'prio', 'status', 'token refreshed']));
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
  if (!meta.accounts[name]) meta.accounts[name] = { priority: 0 };
  meta.accounts[name].lastUsed = Date.now();
  store.saveMeta(meta);
  const info = authInfo(auth);
  out(`now using "${name}"${info.email ? ` (${info.email}, ${info.plan || 'unknown plan'})` : ''}`);
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
  const match = store.listAccounts().find((a) => a.accountId === info.accountId);
  const name = match ? match.name : '(not stored — run "codexswitch import")';
  const note = meta.active && match && meta.active !== match.name ? ` (meta says "${meta.active}" — out of sync)` : '';
  out(`active: ${name}${note}`);
  out(`  email: ${info.email || '-'}\n  plan:  ${info.plan || '-'}\n  token refreshed: ${fmtDate(info.lastRefresh)}`);
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
  const n = parseInt(requireArg(args, 1, 'priority number'), 10);
  if (Number.isNaN(n)) throw new Error('priority must be a number');
  setFlag(name, { priority: n });
  out(`priority of "${name}" set to ${n}`);
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
  for (const a of accounts) {
    if (args.includes(a.name)) continue;
    meta.accounts[a.name] = { ...(meta.accounts[a.name] || {}), priority: prio++ };
  }
  store.saveMeta(meta);
  out('rotation order set:');
  store.listAccounts().forEach((a, i) => out(`${i + 1}. ${a.name}`));
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

// Final argv for "codex exec": inject --skip-git-repo-check so it works in
// non-git folders, and the configured default model — unless the user
// already passed their own flags.
function buildExecArgs(rest, meta) {
  const args = [...rest];
  if (!args.includes('--skip-git-repo-check')) args.unshift('--skip-git-repo-check');
  const hasModel = args.some((a) => a === '-m' || a === '--model' || a.startsWith('--model='));
  if (meta.model && !hasModel) args.unshift('-m', meta.model);
  return args;
}

async function cmdRun(args) {
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
  const meta = store.loadMeta();
  if (rest[0] === 'exec') {
    rest = ['exec', ...buildExecArgs(rest.slice(1), meta)];
  } else if (meta.model && rest.length === 0) {
    rest = ['-m', meta.model];
  }
  out(`[codexswitch] running codex as "${name}"`);
  const res = await runner.runCodex(name, rest);
  return res.code;
}

async function cmdExec(args) {
  let explicit = null;
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-a' || args[i] === '--account') {
      explicit = requireArg(args, ++i, 'account name after --account');
    } else {
      rest.push(args[i]);
    }
  }
  if (explicit && !store.accountExists(explicit)) throw new Error(`no such account: ${explicit}`);

  const meta = store.loadMeta();
  const total = store.listAccounts().length;
  if (total === 0) throw new Error('no accounts — add one with "codexswitch login"');

  const tried = [];
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
    console.error(`[codexswitch] exec as "${name}"${attempt > 0 ? ` (attempt ${attempt + 1})` : ''}`);
    const res = await runner.runCodex(name, ['exec', ...buildExecArgs(rest, meta)], { capture: true });
    if (res.code === 0) {
      store.clearLimited(name);
      return 0;
    }
    if (runner.looksRateLimited(res.output)) {
      const until = Date.now() + runner.limitCooldownMs(res.output, meta.cooldownMinutes);
      store.markLimited(name, until);
      console.error(`[codexswitch] "${name}" hit a usage/rate limit (paused until ${fmtDate(until)}) — rotating`);
      continue;
    }
    return res.code; // real failure, don't burn other accounts on it
  }
  console.error('[codexswitch] all accounts are rate-limited or disabled');
  return 2;
}

async function main(argv) {
  const [cmd, ...args] = argv;
  switch (cmd) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      out(HELP);
      return 0;
    case 'login':
      return cmdLogin(args), 0;
    case 'import':
      return cmdImport(args), 0;
    case 'list':
    case 'accounts':
    case 'status':
      return cmdList(), 0;
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
    case 'add-key':
    case 'apikey':
      return cmdAddKey(args), 0;
    case 'clear-limit': {
      const name = requireArg(args, 0, 'account name');
      store.clearLimited(name);
      out(`cleared rate-limit record for "${name}"`);
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
    default:
      throw new Error(`unknown command "${cmd}" (see "codexswitch help")`);
  }
}

module.exports = { main };
