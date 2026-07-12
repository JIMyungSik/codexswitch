'use strict';

// Zero-dependency smoke test: exercises the full flow against a fake codex
// binary in fully isolated temp directories. Never touches the real
// ~/.codex or ~/.codex-switch.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(os.tmpdir(), `codex-switch-test-${process.pid}`);
const switchHome = path.join(root, 'switch');
const codexHome = path.join(root, 'codex');
const binDir = path.join(root, 'bin');
const cli = path.join(__dirname, '..', 'bin', 'codex-switch.js');
const isWin = process.platform === 'win32';

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
    tokens: { id_token: fakeJwt(email, accountId, plan), access_token: `at-${accountId}`, refresh_token: 'rt', account_id: accountId },
    last_refresh: lastRefresh,
  };
}

// Fake codex behavior:
//  --version        -> ok
//  exec [...]       -> requires --skip-git-repo-check and an overlaid
//                      config.toml; writes a session rollout like real codex
//                      (rate_limits from FAKE_USED_PCT / FAKE_USED_PCT_WEEK);
//                      acc-a fails with a usage-limit unless FAKE_A_OK=1
//                      (or a custom message when FAKE_CUSTOM=1);
//                      prints EXEC_OK / RESUME_OK <id> model=<m>
const fakeCodexJs = path.join(binDir, 'fake-codex.js');
fs.writeFileSync(
  fakeCodexJs,
  `const fs = require('fs'), path = require('path');
const cmd = process.argv[2];
if (cmd === '--version') { console.log('codex-cli 0.0.0-fake'); process.exit(0); }
if (cmd === 'exec') {
  const home = process.env.CODEX_HOME;
  if (!fs.existsSync(path.join(home, 'config.toml'))) { console.error('overlay missing config.toml'); process.exit(3); }
  if (!process.argv.includes('--skip-git-repo-check')) { console.error('missing --skip-git-repo-check'); process.exit(4); }
  const isResume = process.argv[3] === 'resume';
  const mi = process.argv.indexOf('-m');
  const model = mi > -1 ? process.argv[mi + 1] : 'none';
  const auth = JSON.parse(fs.readFileSync(path.join(home, 'auth.json'), 'utf8'));
  const id = auth.tokens ? auth.tokens.account_id : 'apikey:' + auth.OPENAI_API_KEY.slice(0, 8);

  // write a session rollout, like real codex does
  const day = path.join(home, 'sessions', '2026', '07', '09');
  fs.mkdirSync(day, { recursive: true });
  const pct = process.env.FAKE_USED_PCT ? Number(process.env.FAKE_USED_PCT) : null;
  const rl = pct == null ? null : {
    primary: { used_percent: pct, window_minutes: 300, resets_in_seconds: 1800 },
    secondary: { used_percent: Number(process.env.FAKE_USED_PCT_WEEK || 10), window_minutes: 10080, resets_in_seconds: 600000 },
  };
  fs.writeFileSync(
    path.join(day, 'rollout-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.jsonl'),
    JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'token_count', rate_limits: rl } }) + '\\n'
  );

  if (id === 'acc-a' && process.env.FAKE_AUTH_FAIL === '1') {
    console.error('ERROR: Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.');
    process.exit(1);
  }
  if (id === 'acc-a' && process.env.FAKE_CUSTOM === '1') { console.error('MY_CUSTOM_LIMIT reached, come back later'); process.exit(1); }
  if (id === 'acc-a' && process.env.FAKE_A_OK !== '1') {
    console.error("You've hit your usage limit. Try again in 2 hours.");
    process.exit(1);
  }
  if (auth.tokens) {
    auth.last_refresh = '2026-02-02T00:00:00Z'; // simulate a token refresh
    fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify(auth));
  }
  // like real codex (clap): any unknown dash-argument before "--" is fatal
  const sepIdx = process.argv.indexOf('--');
  const KNOWN = ['--skip-git-repo-check', '--last', '-m', '-c', '--sandbox'];
  for (let i = 3; i < (sepIdx === -1 ? process.argv.length : sepIdx); i++) {
    const arg = process.argv[i];
    if (['-m', '-c', '--sandbox'].includes(process.argv[i - 1])) continue; // option values
    if (arg.startsWith('-') && !KNOWN.includes(arg) && arg !== 'resume') {
      console.error("error: unexpected argument '" + arg + "' found");
      process.exit(2);
    }
  }
  const cfgs = [];
  process.argv.forEach((a, i2) => { if (a === '-c') cfgs.push(process.argv[i2 + 1]); });
  const sbi = process.argv.indexOf('--sandbox');
  const sb = sbi > -1 ? ' sb=' + process.argv[sbi + 1] : '';
  const prompt = process.argv[process.argv.length - 1] || '';
  console.log((isResume ? 'RESUME_OK ' : 'EXEC_OK ') + id + ' model=' + model + sb + (cfgs.length ? ' cfg=' + cfgs.join(',') : '') + ' prompt64=' + Buffer.from(prompt).toString('base64'));
  process.exit(0);
}
process.exit(0);
`
);

// Platform wrapper: shebang script on POSIX, .cmd shim on Windows (this also
// exercises the .cmd shell-spawn path in runner.js on Windows CI).
let fakeCodex;
if (isWin) {
  fakeCodex = path.join(binDir, 'codex.cmd');
  fs.writeFileSync(fakeCodex, `@echo off\r\nnode "${fakeCodexJs}" %*\r\n`);
} else {
  fakeCodex = path.join(binDir, 'codex');
  fs.writeFileSync(fakeCodex, `#!/usr/bin/env node\n${fs.readFileSync(fakeCodexJs, 'utf8')}`, { mode: 0o755 });
}

const baseEnv = {
  ...process.env,
  CODEX_SWITCH_HOME: switchHome,
  CODEX_HOME: codexHome,
  CODEX_SWITCH_CODEX_BIN: fakeCodex,
};

function run(args, opts = {}) {
  const r = spawnSync(process.execPath, [cli, ...args], {
    env: { ...baseEnv, ...(opts.env || {}) },
    encoding: 'utf8',
    input: opts.input,
  });
  const res = { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
  if (res.code !== 0 && !opts.allowFail) {
    throw new Error(`codex-switch ${args.join(' ')} failed (${res.code}):\n${res.out}`);
  }
  return res;
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
assert.match(r.out, /2\/2 ready/);

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

// --- exec rotation: acc-a hits the limit, next account RESUMES the session ---
run(['use', 'a@test.com']);
run(['priority', 'a@test.com', '0']);
run(['priority', 'work-b', '1']);
r = run(['exec', 'do the thing']);
assert.match(r.out, /RESUME_OK acc-b model=none/);
assert.match(r.out, /resuming the session/);

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

// --- reasoning: hide/concise inject -c overrides, show removes them ---
run(['reasoning', 'hide']);
r = run(['exec', 'quiet please']);
assert.match(r.out, /cfg=hide_agent_reasoning=true/);
run(['reasoning', 'concise']);
r = run(['exec', 'brief please']);
assert.match(r.out, /cfg=model_reasoning_summary=concise/);
run(['reasoning', 'show']);
r = run(['exec', 'normal again']);
assert.ok(!/cfg=/.test(r.out), 'show mode must not inject -c overrides');

// --- sandbox: write mode injects --sandbox workspace-write ---
run(['sandbox', 'write']);
r = run(['exec', 'edit some files']);
assert.match(r.out, /sb=workspace-write/);
r = run(['exec', '--sandbox', 'read-only', 'explicit wins']);
assert.match(r.out, /sb=read-only/); // user's own flag is respected
run(['sandbox', 'write+net']);
r = run(['exec', 'ssh to server']);
assert.match(r.out, /sb=workspace-write/);
assert.match(r.out, /cfg=sandbox_workspace_write.network_access=true/);
run(['sandbox', 'read-only']);
r = run(['exec', 'back to default']);
assert.ok(!/sb=/.test(r.out), 'default must not inject --sandbox');

// --- --no-resume: rotation restarts the prompt instead of resuming ---
run(['order', 'a@test.com', 'work-b']); // a first, a always limit-fails
run(['clear-limit', 'a@test.com']);
r = run(['exec', '--no-resume', 'restart me']);
assert.match(r.out, /EXEC_OK acc-b/);
assert.ok(!/RESUME_OK/.test(r.out), '--no-resume must not resume');

// --- threshold: usage above the threshold rotates the account out ---
run(['clear-limit', 'a@test.com']);
run(['clear-limit', 'work-b']);
run(['threshold', '90']);
r = run(['threshold']);
assert.match(r.out, /5h 90% \/ weekly 90%/);
run(['order', 'work-b', 'a@test.com']); // b first
r = run(['exec', 'use quota'], { env: { FAKE_USED_PCT: '97' } }); // b reports 97% of 5h
assert.match(r.out, /EXEC_OK acc-b/);
assert.match(r.out, /97% of its 5h limit/);
r = run(['list']);
assert.match(r.out, /over-5h/);
assert.match(r.out, /97%/);
// usage dashboard shows the gauge, reset countdown, and rotation pick
r = run(['usage']);
assert.match(r.out, /97%/);
assert.match(r.out, /resets in/);
assert.match(r.out, /≥ threshold 90%/);
assert.match(r.out, /Next account\s+a@test\.com/);
r = run(['usage', 'work-b']);
assert.match(r.out, /work-b/);
assert.ok(!/a@test\.com \(/.test(r.out), 'single-account usage must filter');
// next exec must skip work-b (over threshold) and use a@test.com
r = run(['exec', 'next task', 'hi'], { env: { FAKE_A_OK: '1' } });
assert.match(r.out, /EXEC_OK acc-a/);

// --- custom limit patterns ---
run(['patterns', 'add', 'MY_CUSTOM_LIMIT']);
r = run(['patterns']);
assert.match(r.out, /custom 1: MY_CUSTOM_LIMIT/);
run(['clear-limit', 'a@test.com']);
run(['clear-limit', 'work-b']);
r = run(['exec', '-a', 'a@test.com', 'x'], { env: { FAKE_CUSTOM: '1' } });
assert.match(r.out, /RESUME_OK acc-b/); // custom message detected -> rotated
run(['patterns', 'remove', '1']);
r = run(['patterns']);
assert.match(r.out, /custom: \(none\)/);

// --- export / restore ---
const backup = path.join(root, 'backup.json');
run(['export', backup]);
assert.ok(fs.existsSync(backup));
run(['remove', 'a@test.com']);
r = run(['list']);
assert.ok(!/a@test\.com/.test(r.out));
run(['restore', backup]);
r = run(['list']);
assert.match(r.out, /a@test\.com/);

// --- api-key account works and can be used in exec ---
run(['add-key', 'api-acct', 'sk-test-1234567890']);
r = run(['list']);
assert.match(r.out, /api-acct/);
assert.match(r.out, /\(api key\)/);
r = run(['exec', '-a', 'api-acct', 'hello']);
assert.match(r.out, /EXEC_OK apikey:sk-test-/);

// --- next wraps around the order ---
run(['remove', 'api-acct']);
run(['clear-limit', 'a@test.com']);
run(['clear-limit', 'work-b']);
run(['use', 'work-b']); // order: work-b(0), a(1); active=b
r = run(['next']);
assert.match(r.out, /now using "a@test\.com"/);
r = run(['next']); // wraps back
assert.match(r.out, /now using "work-b"/);

// --- auth failure: account is disabled with a re-login hint, task rotates ---
run(['order', 'a@test.com', 'work-b']);
run(['clear-limit', 'a@test.com']);
run(['clear-limit', 'work-b']);
r = run(['exec', 'auth test'], { env: { FAKE_AUTH_FAIL: '1' } });
assert.match(r.out, /revoked\/invalid login — disabled/);
assert.match(r.out, /codexswitch login a@test\.com/);
assert.match(r.out, /(EXEC|RESUME)_OK acc-b/); // work continued on b
r = run(['list']);
assert.match(r.out, /disabled/);
// re-importing fresh credentials re-enables the account
fs.writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify(fakeAuth('a@test.com', 'acc-a', 'plus', '2026-04-04T00:00:00Z')));
run(['import', 'a@test.com']);
r = run(['list']);
assert.ok(!/disabled/.test(r.out), 'fresh login must re-enable the account');

// --- team workspaces: same account_id, different emails must not cross-sync ---
fs.writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify(fakeAuth('t1@team.com', 'acc-team', 'team', '2026-01-01T00:00:00Z')));
run(['import', 'team-1']);
fs.writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify(fakeAuth('t2@team.com', 'acc-team', 'team', '2026-01-01T00:00:00Z')));
run(['import', 'team-2']);
// a refresh of t2's token (same acc-team id) must land in team-2, not team-1
fs.writeFileSync(
  path.join(codexHome, 'auth.json'),
  JSON.stringify(fakeAuth('t2@team.com', 'acc-team', 'team', '2026-05-05T00:00:00Z'))
);
run(['sync']);
const team1 = JSON.parse(fs.readFileSync(path.join(switchHome, 'accounts', 'team-1.json'), 'utf8'));
const team2 = JSON.parse(fs.readFileSync(path.join(switchHome, 'accounts', 'team-2.json'), 'utf8'));
assert.strictEqual(team1.last_refresh, '2026-01-01T00:00:00Z', 'team-1 must be untouched');
assert.strictEqual(team2.last_refresh, '2026-05-05T00:00:00Z', 'team-2 must receive the refresh');
run(['remove', 'team-1']);
run(['remove', 'team-2']);
run(['use', 'work-b']);

// --- completion script mentions our commands ---
r = run(['completion', 'bash']);
assert.match(r.out, /complete -F _codexswitch codexswitch cxs/);

// --- unknown commands are forwarded to codex (drop-in replacement) ---
r = run(['goal', 'list']);
assert.match(r.out, /forwarding to codex: codex goal list/);
assert.match(r.out, /running codex as/);

// --- chat: prompt loop; turn 1 execs, turn 2 resumes the same session ---
run(['order', 'work-b', 'a@test.com']);
run(['clear-limit', 'a@test.com']);
run(['clear-limit', 'work-b']);
r = run(['chat'], { input: 'first turn\nsecond turn\n/usage\n/quit\n' });
assert.match(r.out, /codexswitch chat/);
assert.match(r.out, /EXEC_OK acc-b/); // turn 1: fresh exec
assert.match(r.out, /RESUME_OK acc-b/); // turn 2: resumed session
assert.match(r.out, /Next account/); // /usage worked inside chat
// prompts starting with "-" must not be parsed as codex options
r = run(['chat'], { input: '- Recyclespot: fix numbers\n- second dashed turn\n/quit\n' });
assert.match(r.out, /EXEC_OK acc-b/);
assert.match(r.out, /RESUME_OK acc-b/);
assert.ok(!/unexpected argument/.test(r.out), 'dash prompt must be protected by --');
r = run(['exec', '- dashed prompt here']);
assert.match(r.out, /EXEC_OK acc-b/);

// Prompt matrix: quoting, Unicode, whitespace and long inputs survive argv
// forwarding exactly. Repeat each shape to catch state leaking between runs.
const promptMatrix = [
  '한국어 질문: "따옴표"와 이모지 🚀',
  "single 'quote' and $dollar; semicolon",
  'line one\nline two\n- bullet three',
  '- starts with a dash and contains spaces',
  'x'.repeat(4096),
];
for (let repeat = 0; repeat < 3; repeat++) {
  for (const prompt of promptMatrix) {
    r = run(['exec', prompt]);
    assert.match(r.out, new RegExp(`prompt64=${Buffer.from(prompt).toString('base64')}`));
  }
}

// Multiline chat input is collected as one turn and keeps exact newlines.
const pastedPrompt = '첫 줄\n- 둘째 줄\n마지막 "줄"';
r = run(['chat'], { input: `/paste\n${pastedPrompt}\n/end\n/status\n/quit\n` });
assert.match(r.out, /turn 1 · new session · 3 lines/);
assert.match(r.out, new RegExp(`prompt64=${Buffer.from(pastedPrompt).toString('base64')}`));
assert.match(r.out, /reasoning show/);

// In-chat settings are reflected immediately; /new resets turn/session state.
r = run(['chat'], { input: '/reasoning concise\n/status\nfirst\n/new\nsecond\n/quit\n' });
assert.match(r.out, /reasoning concise/);
assert.match(r.out, /cfg=model_reasoning_summary=concise/);
assert.strictEqual((r.out.match(/turn 1 · new session/g) || []).length, 2);
run(['reasoning', 'show']);

// chat rotation: account a limit-fails mid-conversation, b resumes the turn
run(['order', 'a@test.com', 'work-b']);
run(['clear-limit', 'a@test.com']);
r = run(['chat'], { input: 'rotate me\n/quit\n' });
assert.match(r.out, /hit a usage\/rate limit/);
assert.match(r.out, /(EXEC|RESUME)_OK acc-b/); // conversation continued on b

// --- probe: warms up gauges silently, reports per-account usage ---
run(['clear-limit', 'a@test.com']);
run(['clear-limit', 'work-b']);
r = run(['probe', 'work-b'], { env: { FAKE_USED_PCT: '42' } });
assert.match(r.out, /work-b: 5h 42%/);
assert.ok(!/EXEC_OK/.test(r.out), 'probe must not echo codex output');

// --- activity log records switches/limits/probes ---
r = run(['log', '100']);
assert.match(r.out, /probe/);
assert.match(r.out, /switch/);

// --- use-or-lose: unpinned accounts rotate by soonest weekly reset ---
run(['priority', 'a@test.com', 'auto']);
run(['priority', 'work-b', 'auto']);
{
  const metaFile = path.join(switchHome, 'meta.json');
  const m = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  const t = Date.now();
  m.accounts['a@test.com'].usage = { p5h: { pct: 10, resetAt: t + 3600e3 }, weekly: { pct: 10, resetAt: t + 86400e3 }, at: t };
  m.accounts['work-b'].usage = { p5h: { pct: 10, resetAt: t + 3600e3 }, weekly: { pct: 10, resetAt: t + 3600e3 }, at: t }; // resets sooner
  fs.writeFileSync(metaFile, JSON.stringify(m));
}
r = run(['usage']);
assert.match(r.out, /Next account\s+work-b/); // soonest weekly reset wins
run(['priority', 'a@test.com', '0']); // pinning beats use-or-lose
r = run(['usage']);
assert.match(r.out, /Next account\s+a@test\.com/);
run(['clear-limit', 'a@test.com']);
run(['clear-limit', 'work-b']);

// --- EXPERIMENTAL proxy: auth swap, 429 rotation, usage from headers ---
(async () => {
  const httpMod = require('http');
  const { spawn } = require('child_process');

  const upstream = httpMod.createServer((req, res) => {
    const auth = req.headers.authorization || '';
    if (auth.includes('at-acc-a')) {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end('{"error":"rate limit"}');
      return;
    }
    res.writeHead(200, {
      'x-codex-primary-used-percent': '55',
      'x-codex-primary-resets-in-seconds': '1200',
      'x-codex-secondary-used-percent': '22',
      'x-codex-secondary-resets-in-seconds': '500000',
      'x-account': req.headers['chatgpt-account-id'] || '',
    });
    res.end('UPSTREAM_OK');
  });
  await new Promise((r2) => upstream.listen(0, '127.0.0.1', r2));
  const upPort = upstream.address().port;
  const proxyPort = 18437 + (process.pid % 1000);
  const srv = spawn(process.execPath, [cli, 'server', '--port', String(proxyPort)], {
    env: { ...baseEnv, CODEX_SWITCH_UPSTREAM: `http://127.0.0.1:${upPort}` },
    stdio: 'ignore',
  });
  const ping = () =>
    new Promise((res2) => {
      const rq = httpMod.get({ host: '127.0.0.1', port: proxyPort, path: '/__codexswitch' }, (r3) => {
        r3.resume();
        res2(r3.statusCode === 200);
      });
      rq.on('error', () => res2(false));
    });
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    up = await ping();
    if (!up) await new Promise((r4) => setTimeout(r4, 100));
  }
  assert.ok(up, 'proxy server did not start');

  run(['clear-limit', 'a@test.com']);
  run(['clear-limit', 'work-b']);
  run(['order', 'a@test.com', 'work-b']); // a first: upstream 429s a -> proxy must rotate to b
  const resp = await fetch(`http://127.0.0.1:${proxyPort}/backend-api/test`, {
    method: 'POST',
    headers: { authorization: 'Bearer client-original', 'chatgpt-account-id': 'client-orig' },
    body: '{}',
  });
  assert.strictEqual(resp.status, 200);
  assert.strictEqual(await resp.text(), 'UPSTREAM_OK');
  assert.strictEqual(resp.headers.get('x-account'), 'acc-b'); // auth swapped, rotated to b
  const m2 = JSON.parse(fs.readFileSync(path.join(switchHome, 'meta.json'), 'utf8'));
  assert.ok(m2.accounts['a@test.com'].limitedUntil > Date.now(), 'a must be limited after proxy 429');
  assert.strictEqual(Math.round(m2.accounts['work-b'].usage.p5h.pct), 55); // usage from headers

  // run --proxy: profile config.toml is patched to point at the proxy
  run(['clear-limit', 'a@test.com']);
  r = run(['run', '--proxy', 'exec', 'hi']);
  assert.match(r.out, /via proxy :/);
  const profs = fs.readdirSync(path.join(switchHome, 'profiles')).filter((d) => d.endsWith('.proxy'));
  assert.ok(profs.length > 0, 'proxy profile must exist');
  const cfg = fs.readFileSync(path.join(switchHome, 'profiles', profs[0], 'config.toml'), 'utf8');
  assert.ok(cfg.includes(`chatgpt_base_url = "http://127.0.0.1:${proxyPort}/backend-api/"`), 'config must be patched');

  srv.kill('SIGTERM');
  upstream.close();

  // --- disable everything -> exec must fail cleanly ---
  run(['disable', 'a@test.com']);
  run(['disable', 'work-b']);
  r = run(['exec', 'x'], { allowFail: true });
  assert.strictEqual(r.code, 2);
  assert.match(r.out, /all accounts are rate-limited, over threshold, or disabled/);

  // --- remove ---
  run(['enable', 'work-b']);
  run(['remove', 'work-b']);
  r = run(['list']);
  assert.ok(!/work-b/.test(r.out));

  fs.rmSync(root, { recursive: true, force: true });
  console.log('smoke test: all assertions passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
