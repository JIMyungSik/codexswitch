'use strict';

// EXPERIMENTAL local proxy (teamclaude-style): codex is pointed at
// http://127.0.0.1:<port>/backend-api via chatgpt_base_url, and every
// request gets its Authorization / chatgpt-account-id swapped to the
// account chosen by the rotation rules — so even interactive codex
// sessions rotate per request. 429 responses retry on the next account.
// Rate-limit response headers (x-codex-*) feed the usage gauges live.

const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const { URL } = require('url');
const store = require('./store.js');

const DEFAULT_PORT = 8437;
const MAX_BODY = 32 * 1024 * 1024;

function upstreamBase() {
  return new URL(process.env.CODEX_SWITCH_UPSTREAM || 'https://chatgpt.com');
}

function pickAuth(exclude = []) {
  const acct = store.pickAccount(exclude);
  if (!acct) return null;
  const auth = store.readAccountAuth(acct.name);
  const tokens = auth.tokens || {};
  return {
    name: acct.name,
    accountId: tokens.account_id || null,
    token: tokens.access_token || auth.OPENAI_API_KEY || '',
  };
}

// Parse x-codex-(primary|secondary)-* response headers into a usage
// snapshot compatible with the session-file scanner.
function usageFromHeaders(headers) {
  const wins = { primary: {}, secondary: {} };
  let found = false;
  for (const [key, value] of Object.entries(headers)) {
    const m = /^x-codex-(primary|secondary)-(.+)$/i.exec(key);
    if (!m) continue;
    found = true;
    wins[m[1].toLowerCase()][m[2].toLowerCase()] = Number(value);
  }
  if (!found) return null;
  const at = Date.now();
  const win = (w) => {
    const pct = w['used-percent'] ?? w['used_percent'];
    if (typeof pct !== 'number' || Number.isNaN(pct)) return null;
    const resets = w['resets-in-seconds'] ?? w['reset-after-seconds'] ?? w['resets_in_seconds'];
    return {
      pct,
      resetAt: typeof resets === 'number' && !Number.isNaN(resets) ? at + resets * 1000 : null,
      windowMinutes: w['window-minutes'] ?? null,
    };
  };
  const p5h = win(wins.primary);
  const weekly = win(wins.secondary);
  if (!p5h && !weekly) return null;
  return { p5h, weekly, at };
}

function swapHeaders(headers, acct, host) {
  const h = {};
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    if (lk === 'host' || lk === 'content-length' || lk === 'connection') continue;
    h[k] = v;
  }
  h.host = host;
  h.authorization = `Bearer ${acct.token}`;
  if (acct.accountId) h['chatgpt-account-id'] = acct.accountId;
  return h;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function forwardOnce(req, body, acct) {
  return new Promise((resolve, reject) => {
    const base = upstreamBase();
    const mod = base.protocol === 'https:' ? https : http;
    const up = mod.request(
      {
        hostname: base.hostname,
        port: base.port || (base.protocol === 'https:' ? 443 : 80),
        path: req.url,
        method: req.method,
        headers: { ...swapHeaders(req.headers, acct, base.host), 'content-length': body.length },
      },
      (upRes) => resolve(upRes)
    );
    up.on('error', reject);
    up.end(body);
  });
}

function startServer({ port = DEFAULT_PORT, log = () => {} } = {}) {
  const server = http.createServer(async (req, res) => {
    if (req.url === '/__codexswitch') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, accounts: store.listAccounts().length }));
      return;
    }
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      res.writeHead(413).end(e.message);
      return;
    }
    const meta = store.loadMeta();
    const total = store.listAccounts().length;
    const tried = [];
    for (let attempt = 0; attempt < Math.max(1, total); attempt++) {
      const acct = pickAuth(tried);
      if (!acct) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'codexswitch: no usable account' }));
        return;
      }
      tried.push(acct.name);
      let upRes;
      try {
        upRes = await forwardOnce(req, body, acct);
      } catch (e) {
        log('error', `${acct.name}: upstream ${e.message}`);
        res.writeHead(502).end(`codexswitch: upstream error: ${e.message}`);
        return;
      }
      const usage = usageFromHeaders(upRes.headers);
      if (usage) store.saveUsage(acct.name, usage);
      if (upRes.statusCode === 429 && tried.length < total) {
        store.markLimited(acct.name, Date.now() + meta.cooldownMinutes * 60000);
        store.logEvent('limit', `proxy: "${acct.name}" got 429 — rotating`);
        log('rotate', `${acct.name} hit 429 -> trying next account`);
        upRes.resume(); // discard
        continue;
      }
      log('req', `${acct.name} ${req.method} ${req.url} -> ${upRes.statusCode}`);
      res.writeHead(upRes.statusCode, upRes.headers);
      upRes.pipe(res);
      return;
    }
    res.writeHead(503).end('codexswitch: all accounts exhausted');
  });

  // WebSocket passthrough: swap auth on the handshake, then pipe raw bytes.
  server.on('upgrade', (req, socket, head) => {
    const acct = pickAuth();
    if (!acct) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      return;
    }
    const base = upstreamBase();
    const isTls = base.protocol === 'https:';
    const upPort = base.port || (isTls ? 443 : 80);
    const upstream = isTls
      ? tls.connect({ host: base.hostname, port: upPort, servername: base.hostname })
      : net.connect({ host: base.hostname, port: upPort });
    const onReady = () => {
      const headers = swapHeaders(req.headers, acct, base.host);
      headers.connection = 'Upgrade';
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
      upstream.write(lines.join('\r\n') + '\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
      log('ws', `${acct.name} ${req.url}`);
      store.logEvent('exec', `proxy ws opened as "${acct.name}"`);
    };
    upstream.on(isTls ? 'secureConnect' : 'connect', onReady);
    const drop = () => {
      socket.destroy();
      upstream.destroy();
    };
    upstream.on('error', drop);
    socket.on('error', drop);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

// Is a codexswitch proxy answering on this port?
function ping(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/__codexswitch', timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

module.exports = { startServer, ping, DEFAULT_PORT, usageFromHeaders };
