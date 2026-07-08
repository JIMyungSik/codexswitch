'use strict';

// Zero-dependency smoke test: exercises import/list/use/rotation against a
// fake codex binary in fully isolated temp directories. Never touches the
// real ~/.codex or ~/.codex-switch.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(os.tmpdir(), `codex-switch-test-${process.pid}`);
const switchHome = path.join(root, 'switch');
const codexHome = path.join(root, 'codex');
const binDir = path.join(root, 'bin');
const cli = path.join(__dirname, '..', 'bin', 'codex-switch.js');

fs.rmSync(root, { recursive: true, force: true });
for (const d of [switchHome, codexHome, binDir]) fs.mkdirSync(d, { recursive: true });

function fakeJwt(email, accountId, plan) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64({
    email,
    'https://api.openai.com/auth': { chatgpt_plan_type: plan, chatgpt_account_id: accountId },
  })}.sig`;
}

function fakeAuth(email, accountId, plan = 'plus', lastRefresh = '2026-01-01T00:00:00Z') {
  return {
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: { id_token: fakeJwt(email, accountId, plan), access_token: 'at', refresh_token: 'rt', account_id: accountId },
    last_refresh: lastRefresh,
  };
}

// Fake codex: `--version` ok; `exec` fails with a usage-limit message for
// account acc-a, succeeds for anyone else, and asserts the overlay works.
const fakeCodex = path.join(binDir, 'codex');
fs.writeFileSync(
  fakeCodex,
  `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const cmd = process.argv[2];
if (cmd === '--version') { console.log('codex-cli 0.0.0-fake'); process.exit(0); }
if (cmd === 'exec') {
  const home = process.env.CODEX_HOME;
  if (!fs.existsSync(path.join(home, 'config.toml'))) { console.error('overlay missing config.toml'); process.exit(3); }
  if (!process.argv.includes('--skip-git-repo-check')) { console.error('missing --skip-git-repo-check'); process.exit(4); }
  const mi = process.argv.indexOf('-m');
  const model = mi > -1 ? process.argv[mi + 1] : 'none';
  const auth = JSON.parse(fs.readFileSync(path.join(home, 'auth.json'), 'utf8'));
  const id = auth.tokens ? auth.tokens.account_id : 'apikey:' + auth.OPENAI_API_KEY.slice(0, 8);
  if (id === 'acc-a') {
    console.error("You've hit your usage limit. Try again in 2 hours.");
    process.exit(1);
  }
  if (auth.tokens) {
    auth.last_refresh = '2026-02-02T00:00:00Z'; // simulate a token refresh
    fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify(auth));
  }
  console.log('EXEC_OK ' + id + ' model=' + model);
  process.exit(0);
}
process.exit(0);
`,
  { mode: 0o755 }
);

const env = {
  ...process.env,
  CODEX_SWITCH_HOME: switchHome,
  CODEX_HOME: codexHome,
  CODEX_SWITCH_CODEX_BIN: fakeCodex,
};

function run(args, opts = {}) {
  try {
    return { code: 0, out: execFileSync(process.execPath, [cli, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) {
    if (opts.allowFail) return { code: e.status, out: `${e.stdout || ''}${e.stderr || ''}` };
    throw new Error(`codex-switch ${args.join(' ')} failed (${e.status}):\n${e.stdout}\n${e.stderr}`);
  }
}

// --- import two accounts ---
fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "gpt-5.2-codex"\n');
fs.writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify(fakeAuth('a@test.com', 'acc-a')));
let r = run(['import']);
assert.match(r.out, /added account "a@test.com"/);
assert.match(r.out, /active/);

fs.writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify(fakeAuth('b@test.com', 'acc-b', 'pro')));
run(['import', 'work-b']);

r = run(['list']);
assert.match(r.out, /a@test\.com/);
assert.match(r.out, /work-b/);
assert.match(r.out, /pro/);

// --- use / current ---
run(['use', 'a@test.com']);
const live = JSON.parse(fs.readFileSync(path.join(codexHome, 'auth.json'), 'utf8'));
assert.strictEqual(live.tokens.account_id, 'acc-a');
r = run(['current']);
assert.match(r.out, /active: a@test\.com/);

// --- sync-back: a refresh in ~/.codex lands in the store on next switch ---
live.last_refresh = '2026-03-03T00:00:00Z';
fs.writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify(live));
run(['use', 'work-b']);
const storedA = JSON.parse(fs.readFileSync(path.join(switchHome, 'accounts', 'a@test.com.json'), 'utf8'));
assert.strictEqual(storedA.last_refresh, '2026-03-03T00:00:00Z');

// --- exec rotation: acc-a hits the limit, rotation lands on acc-b ---
run(['use', 'a@test.com']);
run(['priority', 'a@test.com', '0']);
run(['priority', 'work-b', '1']);
r = run(['exec', 'do the thing']);
assert.match(r.out, /EXEC_OK acc-b/);

// acc-a must now be marked limited (~2h from the error message)
const meta = JSON.parse(fs.readFileSync(path.join(switchHome, 'meta.json'), 'utf8'));
const limited = meta.accounts['a@test.com'].limitedUntil - Date.now();
assert.ok(limited > 1.5 * 3600000 && limited < 2.5 * 3600000, `unexpected cooldown ${limited}`);

// token refresh made by (fake) codex inside the overlay must be synced back
const storedB = JSON.parse(fs.readFileSync(path.join(switchHome, 'accounts', 'work-b.json'), 'utf8'));
assert.strictEqual(storedB.last_refresh, '2026-02-02T00:00:00Z');

// --- next: skips the limited account? only b is usable and b!=active ---
r = run(['next']);
assert.match(r.out, /now using "work-b"/);

// --- model: persisted default is injected into exec ---
run(['model', 'gpt-test-1']);
r = run(['model']);
assert.match(r.out, /gpt-test-1/);

// --- order: rotation follows the configured order strictly ---
run(['clear-limit', 'a@test.com']);
r = run(['order', 'work-b', 'a@test.com']); // b first now
assert.match(r.out, /1\. work-b/);
r = run(['exec', 'hello']);
assert.match(r.out, /EXEC_OK acc-b model=gpt-test-1/);
assert.ok(!/rotating/.test(r.out), 'should start with work-b per order, no rotation');

// user-provided -m must win over the stored default
r = run(['exec', '-m', 'gpt-user-2', 'hello']);
assert.match(r.out, /model=gpt-user-2/);

// --- add-key: API-key account works and can be used in exec ---
run(['add-key', 'api-acct', 'sk-test-1234567890']);
r = run(['list']);
assert.match(r.out, /api-acct/);
assert.match(r.out, /\(api key\)/);
r = run(['exec', '-a', 'api-acct', 'hello']);
assert.match(r.out, /EXEC_OK apikey:sk-test-/);

// --- next wraps around the order ---
run(['remove', 'api-acct']);
run(['use', 'work-b']); // order: work-b(0), a(1); active=b
r = run(['next']);
assert.match(r.out, /now using "a@test\.com"/);
r = run(['next']); // wraps back
assert.match(r.out, /now using "work-b"/);

// --- disable everything -> exec must fail cleanly ---
run(['disable', 'work-b']);
r = run(['exec', 'x'], { allowFail: true });
assert.strictEqual(r.code, 2);
assert.match(r.out, /all accounts are rate-limited or disabled/);

// --- remove ---
run(['enable', 'work-b']);
run(['remove', 'work-b']);
r = run(['list']);
assert.ok(!/work-b/.test(r.out));

fs.rmSync(root, { recursive: true, force: true });
console.log('smoke test: all assertions passed');
