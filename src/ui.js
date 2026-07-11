'use strict';

// Tiny ANSI color layer (zero deps). Colors turn off automatically when the
// output is piped, or when NO_COLOR is set — so scripts and tests always see
// plain text (https://no-color.org).
const enabled =
  process.env.NO_COLOR == null &&
  process.env.FORCE_COLOR !== '0' &&
  (Boolean(process.stdout.isTTY) || Boolean(process.env.FORCE_COLOR));

const wrap = (open, close) => (s) => (enabled ? `[${open}m${s}[${close}m` : String(s));

const green = wrap(32, 39);
const red = wrap(31, 39);
const yellow = wrap(33, 39);
const cyan = wrap(36, 39);
const dim = wrap(2, 22);
const bold = wrap(1, 22);

module.exports = {
  enabled,
  green,
  red,
  yellow,
  cyan,
  dim,
  bold,
  // status line prefixes — one glyph per kind keeps progress scannable
  ok: (s) => `${green('✓')} ${s}`,
  info: (s) => `${cyan('›')} ${s}`,
  warn: (s) => `${yellow('⚠')} ${s}`,
  fail: (s) => `${red('✗')} ${s}`,
  // strip ANSI codes (for width calculations)
  visible: (s) => String(s).replace(/\[[0-9;]*m/g, ''),
};
