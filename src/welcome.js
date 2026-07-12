'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const store = require('./store.js');
const ui = require('./ui.js');
const { displayWidth, fmtRemaining } = require('./util.js');
const pkg = require('../package.json');

const MIN_WIDTH = 76;
const MIN_HEIGHT = 22;

function crop(value, width) {
  const text = String(value == null ? '' : value);
  if (displayWidth(text) <= width) return text;
  let out = '';
  for (const ch of text) {
    if (displayWidth(out + ch + '…') > width) break;
    out += ch;
  }
  return out + '…';
}

function fit(value, width) {
  const text = crop(value, width);
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

function center(value, width) {
  const text = crop(value, width);
  const gap = Math.max(0, width - displayWidth(text));
  return ' '.repeat(Math.floor(gap / 2)) + text + ' '.repeat(Math.ceil(gap / 2));
}

function percent(account) {
  const win = account.usage && account.usage.p5h;
  return win && typeof win.pct === 'number' ? `${Math.round(win.pct)}%` : '--';
}

function accountState(account, now = Date.now()) {
  if (account.disabled) return 'disabled';
  if (account.limitedUntil && account.limitedUntil > now) return `paused ${fmtRemaining(account.limitedUntil)}`;
  return 'ready';
}

function projectPulse(cwd = process.cwd()) {
  const branch = spawnSync('git', ['branch', '--show-current'], { cwd, encoding: 'utf8' });
  const status = spawnSync('git', ['status', '--short'], { cwd, encoding: 'utf8' });
  return {
    branch: branch.status === 0 && branch.stdout.trim() ? branch.stdout.trim() : '(not a git repository)',
    changes: status.status === 0 && status.stdout.trim() ? status.stdout.trim().split(/\r?\n/).length : 0,
  };
}

function welcomeState() {
  const meta = store.loadMeta();
  const accounts = store.listAccounts();
  const active = accounts.find((a) => a.active) || store.pickAccount() || accounts[0] || null;
  return {
    version: pkg.version,
    accounts,
    active,
    model: meta.model || 'default',
    reasoning: meta.reasoning || 'show',
    memory: meta.memoryMode || 'off',
    output: meta.outputMode || 'auto',
    history: store.readRuns(3),
    project: projectPulse(),
    cwd: process.cwd(),
  };
}

function buildWelcomeFrame({ width, height, input = '', state = welcomeState() }) {
  if (width < MIN_WIDTH || height < MIN_HEIGHT) return null;
  const inner = width - 2;
  const leftW = Math.max(34, Math.floor(inner * 0.49));
  const rightW = inner - leftW - 1;
  const bodyH = height - 6;
  const left = [];
  const right = [];

  const logo = [
    ' ██████╗██╗  ██╗███████╗',
    '██╔════╝╚██╗██╔╝██╔════╝',
    '██║      ╚███╔╝ ███████╗',
    '██║      ██╔██╗ ╚════██║',
    '╚██████╗██╔╝ ██╗███████║',
    ' ╚═════╝╚═╝  ╚═╝╚══════╝',
  ];
  const topPad = Math.max(1, Math.floor((bodyH - 14) / 2));
  for (let i = 0; i < topPad; i++) left.push('');
  left.push(center(ui.bold(ui.cyan('CODEX SWITCH')), leftW));
  left.push(center(ui.dim('rotate · continue · remember'), leftW));
  left.push('');
  logo.forEach((line) => left.push(center(ui.cyan(line), leftW)));
  left.push('');
  left.push(center(state.active ? `${ui.green('●')} ${ui.bold(state.active.name)} · ${accountState(state.active)} · ${percent(state.active)}` : ui.yellow('No usable account'), leftW));
  left.push(center(ui.dim(`${state.accounts.length} account(s) · memory ${state.memory}`), leftW));

  right.push(ui.bold(ui.cyan('Quick commands')));
  right.push(ui.dim('/help  /usage  /history  /output  /memory  /new'));
  right.push(ui.dim('Enter send · /paste multiline · /quit exit'));
  right.push(ui.dim('─'.repeat(Math.max(1, rightW))));
  right.push(ui.bold(ui.cyan('Account pool')));
  for (const account of state.accounts.slice(0, 5)) {
    const mark = account.active ? ui.green('●') : '○';
    right.push(`${mark} ${account.name}  ${ui.dim(`${accountState(account)} · 5h ${percent(account)}`)}`);
  }
  if (state.accounts.length > 5) right.push(ui.dim(`… ${state.accounts.length - 5} more`));
  right.push(ui.dim('─'.repeat(Math.max(1, rightW))));
  right.push(ui.bold(ui.cyan('Project pulse')));
  right.push(`branch ${ui.bold(state.project.branch)} · ${state.project.changes} change(s)`);
  right.push(ui.dim(crop(state.cwd, rightW)));
  right.push(ui.dim('─'.repeat(Math.max(1, rightW))));
  right.push(ui.bold(ui.cyan('Session trail')));
  if (state.history.length === 0) right.push(ui.dim('No saved work history'));
  else state.history.forEach((run) => right.push(`${run.status === 'done' ? ui.green('✓') : ui.yellow('!')} ${crop(run.prompt || '(no prompt)', Math.max(8, rightW - 13))} ${ui.dim(run.id)}`));

  while (left.length < bodyH) left.push('');
  while (right.length < bodyH) right.push('');
  const title = ` cxs v${state.version} · persistent Codex workspace `;
  const topLeft = Math.max(0, leftW - displayWidth(title) - 1);
  const lines = [`┌─${title}${'─'.repeat(topLeft)}┬${'─'.repeat(rightW)}┐`];
  for (let i = 0; i < bodyH; i++) lines.push(`│${fit(left[i], leftW)}│${fit(right[i], rightW)}│`);
  lines.push(`└${'─'.repeat(leftW)}┴${'─'.repeat(rightW)}┘`);

  const status = state.active
    ? `${ui.green('●')} ${state.active.name} · model ${state.model} · reasoning ${state.reasoning} · ${crop(state.cwd, Math.max(8, width - 48))}`
    : ui.yellow('No usable account');
  lines.push(fit(status, width));
  lines.push(`┌${'─'.repeat(width - 2)}┐`);
  const prompt = input ? `› ${input}` : ui.dim('› Type your message…  Enter: send · /help: commands · Ctrl-C: exit');
  lines.push(`│${fit(prompt, width - 2)}│`);
  lines.push(`└${'─'.repeat(width - 2)}┘`);
  return lines.slice(0, height).map((line) => fit(line, width)).join('\r\n');
}

async function readWelcomePrompt() {
  if (!process.stdin.isTTY || !process.stdout.isTTY || process.env.CXS_SIMPLE_UI === '1') return { prompt: null, shown: false };
  if ((process.stdout.columns || 80) < MIN_WIDTH || (process.stdout.rows || 24) < MIN_HEIGHT) return { prompt: null, shown: false };
  let input = '';
  let done = false;
  const draw = () => {
    const frame = buildWelcomeFrame({
      width: process.stdout.columns || 80,
      height: process.stdout.rows || 24,
      input,
    });
    if (frame) process.stdout.write(`\x1b[H${frame}`);
  };
  process.stdout.write('\x1b[?1049h\x1b[2J\x1b[H\x1b[?25h');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  draw();
  const prompt = await new Promise((resolve) => {
    const onResize = () => draw();
    const finish = (value) => {
      if (done) return;
      done = true;
      process.stdin.removeListener('data', onData);
      process.stdout.removeListener('resize', onResize);
      resolve(value);
    };
    const onData = (data) => {
      if (data === '\u0003' || data === '\u0004' || data === '\u001b') return finish(null);
      if (data === '\r' || data === '\n') {
        if (input.trim()) finish(input.trim());
        return;
      }
      if (data === '\u007f' || data === '\b') input = Array.from(input).slice(0, -1).join('');
      else if (!data.startsWith('\u001b')) input += Array.from(data).filter((ch) => ch >= ' ' && ch !== '\u007f').join('');
      draw();
    };
    process.stdin.on('data', onData);
    process.stdout.on('resize', onResize);
  });
  try { process.stdin.setRawMode(false); } catch { /* best effort */ }
  process.stdin.pause();
  process.stdout.write('\x1b[?25h\x1b[?1049l');
  return { prompt, shown: true };
}

module.exports = { buildWelcomeFrame, readWelcomePrompt, welcomeState, MIN_WIDTH, MIN_HEIGHT };
