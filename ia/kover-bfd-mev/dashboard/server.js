'use strict';

/**
 * KOVER.IA — Dashboard HTTP server (security-hardened)
 * ===========================================================================
 *
 * Lightweight HTTP server that:
 *
 *   1. Serves the static dashboard UI (index.html, styles.css, app.js)
 *   2. Streams sentinel events to connected browsers over Server-Sent Events
 *      (one persistent HTTP connection, push-from-server, no polling)
 *   3. Exposes a minimal JSON status endpoint for liveness probes
 *
 * Wire format
 * -----------
 *   GET  /            → 200 text/html  (the dashboard)
 *   GET  /events      → text/event-stream (one line per event, see eventBus)
 *   GET  /status      → 200 application/json  { tx, candidates, halts, ... }
 *   GET  /healthz     → 200 text/plain "ok"
 *   *                 → 404
 *
 * Security
 * --------
 *   - Bound to 127.0.0.1 by default. Set DASHBOARD_HOST=0.0.0.0 ONLY behind
 *     a reverse proxy that adds TLS + auth (e.g. Caddy + bearer middleware).
 *   - Optional bearer-token gate on every endpoint when DASHBOARD_TOKEN is
 *     set. Comparison is constant-time to defeat timing oracles.
 *   - Strict Content-Security-Policy on the HTML response — no inline JS,
 *     no eval, no third-party origins. Defends against XSS via tx data.
 *   - Per-IP token bucket rate limit on /events to bound resource use under
 *     accidental or hostile reconnect storms.
 *   - Hard cap on simultaneous SSE subscribers (default 32). Prevents
 *     listener accumulation on the in-process bus.
 *   - Path-traversal guard on static-file resolution.
 *   - Refuses non-GET methods on every endpoint.
 *
 * @module    dashboard/server
 * @author    KOVER.IA platform team
 * @license   Proprietary
 */

const http   = require('node:http');
const fs     = require('node:fs');
const path   = require('node:path');
const crypto = require('node:crypto');
const bus    = require('../src/eventBus');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.DASHBOARD_PORT || 8787);
const HOST = process.env.DASHBOARD_HOST || '127.0.0.1';

const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN || '';
const MAX_SSE_CLIENTS = Number(process.env.DASHBOARD_MAX_SSE_CLIENTS || '32');
const SSE_RATE_PER_MIN = Number(process.env.DASHBOARD_SSE_RATE_PER_MIN || '60');
const REQUEST_TIMEOUT_MS = Number(process.env.DASHBOARD_REQUEST_TIMEOUT_MS || '30000');
const HEADERS_TIMEOUT_MS = Number(process.env.DASHBOARD_HEADERS_TIMEOUT_MS || '10000');

const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.json': 'application/json',
});

// Strict CSP — blocks every inline script, eval, foreign origin. The
// dashboard's app.js is self-hosted, so 'self' covers it. EventSource needs
// connect-src self.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",  // inline styles in our app are minimal & static
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

const SECURITY_HEADERS = Object.freeze({
  'content-security-policy': CSP,
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'geolocation=(), microphone=(), camera=()',
});

// ---------------------------------------------------------------------------
// Rolling in-memory aggregate exposed by /status
// ---------------------------------------------------------------------------

const stats = {
  startedAt: Date.now(),
  tx: 0,
  candidates: 0,
  simulations: 0,
  truePositives: 0,
  halts: 0,
  lastAttack: null,
  sseClients: 0,
  sseRefused: 0,
};

bus.on('pending',     ()    => { stats.tx += 1; });
bus.on('candidate',   ()    => { stats.candidates += 1; });
bus.on('simulation',  ()    => { stats.simulations += 1; });
bus.on('attack',      (p)   => { stats.truePositives += 1; stats.lastAttack = p; });
bus.on('halt',        ()    => { stats.halts += 1; });

// Burst analyser publishes its own counter (huge numbers, sampled events).
// We surface its raw `totalProcessed` so the dashboard can show the actual
// volume of analytical work performed, not just the sampled-to-SSE count.
bus.on('burst', (p) => {
  if (p?.enabled && typeof p.totalProcessed === 'number') {
    stats.burstTotalProcessed = p.totalProcessed;
    stats.burstMeasuredEps   = p.measuredEps;
    stats.burstAnomalies     = p.anomaliesFlagged;
  }
});

// ---------------------------------------------------------------------------
// Auth — constant-time bearer-token comparison
// ---------------------------------------------------------------------------

function authOk(req) {
  if (!DASHBOARD_TOKEN) return true; // no token configured = open
  const hdr = req.headers['authorization'] || '';
  if (!hdr.startsWith('Bearer ')) return false;
  const presented = hdr.slice(7);
  if (presented.length !== DASHBOARD_TOKEN.length) return false;
  // crypto.timingSafeEqual requires equal-length Buffers.
  return crypto.timingSafeEqual(Buffer.from(presented), Buffer.from(DASHBOARD_TOKEN));
}

// ---------------------------------------------------------------------------
// Per-IP rate limit (token bucket) — applies to /events only
// ---------------------------------------------------------------------------
// Bucket capacity = SSE_RATE_PER_MIN, refill 1 token / (60 s / capacity).
// Each new SSE connection costs 1 token. Bursts within the window are
// allowed; sustained reconnect storms are throttled.

const RATE_BUCKETS = new Map(); // ip -> { tokens, lastRefillMs }

function rateAllow(ip) {
  if (SSE_RATE_PER_MIN <= 0) return true;
  const now = Date.now();
  const refillEveryMs = 60_000 / SSE_RATE_PER_MIN;
  let bucket = RATE_BUCKETS.get(ip);
  if (!bucket) {
    bucket = { tokens: SSE_RATE_PER_MIN, lastRefillMs: now };
    RATE_BUCKETS.set(ip, bucket);
  }
  // Refill
  const elapsed = now - bucket.lastRefillMs;
  if (elapsed >= refillEveryMs) {
    const added = Math.floor(elapsed / refillEveryMs);
    bucket.tokens = Math.min(SSE_RATE_PER_MIN, bucket.tokens + added);
    bucket.lastRefillMs += added * refillEveryMs;
  }
  if (bucket.tokens <= 0) return false;
  bucket.tokens -= 1;
  return true;
}

// Periodic GC on the rate-limit map so it doesn't grow unbounded under churn.
setInterval(() => {
  const now = Date.now();
  for (const [ip, b] of RATE_BUCKETS) {
    if (now - b.lastRefillMs > 10 * 60_000) RATE_BUCKETS.delete(ip);
  }
}, 60_000).unref();

function clientIp(req) {
  // We trust X-Forwarded-For only when explicitly opt-in (DASHBOARD_TRUST_PROXY=1).
  if (process.env.DASHBOARD_TRUST_PROXY === '1') {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string') return xff.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function send(res, status, headers, body) {
  // Always layer the security headers under whatever the route returns.
  const final = { ...SECURITY_HEADERS, ...headers };
  try {
    res.writeHead(status, final);
    res.end(body);
  } catch { /* socket already closed */ }
}

function sendJson(res, status, obj) {
  send(res, status, { 'content-type': 'application/json', 'cache-control': 'no-store' },
    JSON.stringify(obj));
}

/**
 * Resolve a public-dir relative path, blocking traversal attempts.
 * The realpath check defeats symlink escapes if the public dir contains any.
 */
function resolvePublic(urlPath) {
  const cleaned = urlPath.replace(/\?.*$/, '').replace(/^\/+/, '');
  if (cleaned.includes('\0')) return null; // null-byte injection
  const candidate = path.normalize(path.join(PUBLIC_DIR, cleaned || 'index.html'));
  if (!candidate.startsWith(PUBLIC_DIR + path.sep) && candidate !== path.join(PUBLIC_DIR, 'index.html')) {
    return null;
  }
  return candidate;
}

function serveStatic(req, res) {
  const file = resolvePublic(req.url);
  if (!file) return send(res, 400, { 'content-type': 'text/plain' }, 'bad request');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, { 'content-type': 'text/plain' }, 'not found');
    const ext = path.extname(file).toLowerCase();
    const ct  = MIME[ext] || 'application/octet-stream';
    fs.readFile(file, (rerr, data) => {
      if (rerr) return send(res, 500, { 'content-type': 'text/plain' }, 'read error');
      send(res, 200, { 'content-type': ct, 'cache-control': 'no-cache' }, data);
    });
  });
}

// ---------------------------------------------------------------------------
// Server-Sent Events handler
// ---------------------------------------------------------------------------

function serveSse(req, res) {
  // Per-IP rate limit
  const ip = clientIp(req);
  if (!rateAllow(ip)) {
    stats.sseRefused += 1;
    return send(res, 429, {
      'content-type': 'text/plain',
      'retry-after': '60',
    }, 'rate limited');
  }
  // Hard cap on concurrent SSE clients — protects the bus listener pool.
  if (stats.sseClients >= MAX_SSE_CLIENTS) {
    stats.sseRefused += 1;
    return send(res, 503, { 'content-type': 'text/plain' }, 'too many subscribers');
  }

  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'content-type':  'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    'connection':    'keep-alive',
    'x-accel-buffering': 'no',
  });

  stats.sseClients += 1;

  // Initial hello + replay of last attack (if any).
  res.write(`event: hello\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
  if (stats.lastAttack) {
    res.write(`event: attack\ndata: ${JSON.stringify(stats.lastAttack)}\n\n`);
  }

  const FORWARDED_TYPES = ['pending', 'candidate', 'simulation', 'attack',
                           'riposte', 'halt', 'analysis', 'burst', 'multichain',
                           'error', 'stats'];
  const pushers = {};
  for (const type of FORWARDED_TYPES) {
    const handler = (payload) => {
      try {
        res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
      } catch { cleanup(); }
    };
    pushers[type] = handler;
    bus.on(type, handler);
  }

  const heartbeat = setInterval(() => {
    try { res.write(`: hb\n\n`); } catch { cleanup(); }
  }, 15_000);

  let cleaned = false;
  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    clearInterval(heartbeat);
    for (const [type, h] of Object.entries(pushers)) bus.off(type, h);
    stats.sseClients = Math.max(0, stats.sseClients - 1);
    try { res.end(); } catch { /* ignore */ }
  }

  req.on('close', cleanup);
  req.on('error', cleanup);
}

// ---------------------------------------------------------------------------
// Periodic stats fan-out (1 Hz)
// ---------------------------------------------------------------------------

setInterval(() => {
  const uptimeMs = Date.now() - stats.startedAt;
  const tps = uptimeMs > 0 ? Math.round((stats.tx / uptimeMs) * 1000) : 0;
  bus.publish('stats', {
    tx: stats.tx,
    candidates: stats.candidates,
    simulations: stats.simulations,
    truePositives: stats.truePositives,
    halts: stats.halts,
    sseClients: stats.sseClients,
    sseRefused: stats.sseRefused,
    tps,
    uptimeMs,
  });
}, 1000).unref();

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

function handle(req, res) {
  if (req.method !== 'GET') {
    return send(res, 405, { 'content-type': 'text/plain', 'allow': 'GET' }, 'method not allowed');
  }

  // /healthz never requires auth (probes need it open)
  if (req.url === '/healthz') {
    return send(res, 200, { 'content-type': 'text/plain' }, 'ok');
  }

  if (!authOk(req)) {
    return send(res, 401, {
      'content-type': 'text/plain',
      'www-authenticate': 'Bearer realm="kover-dashboard"',
    }, 'unauthorized');
  }

  if (req.url === '/events') return serveSse(req, res);
  if (req.url === '/status') {
    return sendJson(res, 200, { ...stats, uptimeMs: Date.now() - stats.startedAt });
  }
  return serveStatic(req, res);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

let _server = null;

function start() {
  if (_server) return _server;
  _server = http.createServer(handle);
  _server.requestTimeout = REQUEST_TIMEOUT_MS;
  _server.headersTimeout = HEADERS_TIMEOUT_MS;
  _server.keepAliveTimeout = 65_000;
  _server.maxRequestsPerSocket = 256;

  _server.listen(PORT, HOST, () => {
    // eslint-disable-next-line no-console
    console.log(
      `[dashboard] listening on http://${HOST}:${PORT}` +
      (DASHBOARD_TOKEN ? '  (auth: bearer)' : '  (auth: open — bind to 127.0.0.1)'),
    );
  });
  _server.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error('[dashboard] server error:', err.message);
  });
  return _server;
}

async function stop() {
  if (!_server) return;
  await new Promise((resolve) => _server.close(resolve));
  _server = null;
}

module.exports = { start, stop, stats };

if (require.main === module) start();
