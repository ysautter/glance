const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// ── Config ──────────────────────────────────────────────────
const GITLAB_URL = (process.env.GITLAB_URL || '').replace(/\/$/, '');
const GITLAB_TOKEN = process.env.GITLAB_TOKEN || '';
const SOURCE_TYPE = process.env.SOURCE_TYPE || 'project';
const SOURCE_PATH = process.env.SOURCE_PATH || '';
const AUTH_USER = process.env.AUTH_USER || '';
const AUTH_PASS = process.env.AUTH_PASS || '';
const ADMIN_USER = process.env.ADMIN_USER || '';
const ADMIN_PASS = process.env.ADMIN_PASS || '';
const PORT = parseInt(process.env.PORT || '3000', 10);
const BOARDS_FILE = path.join(__dirname, 'boards.json');

for (const [k, v] of [['GITLAB_URL', GITLAB_URL], ['GITLAB_TOKEN', GITLAB_TOKEN], ['SOURCE_PATH', SOURCE_PATH], ['AUTH_USER', AUTH_USER], ['AUTH_PASS', AUTH_PASS], ['ADMIN_USER', ADMIN_USER], ['ADMIN_PASS', ADMIN_PASS]]) {
  if (!v) { console.error(`Missing required env var: ${k}`); process.exit(1); }
}

// ── Boards persistence ──────────────────────────────────────
function loadBoards() {
  try { return JSON.parse(fs.readFileSync(BOARDS_FILE, 'utf-8')); }
  catch { return []; }
}
function saveBoards(boards) {
  fs.writeFileSync(BOARDS_FILE, JSON.stringify(boards, null, 2));
}

// ── Prepare index.html with served-mode config ──────────────
const rawHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf-8');
// Config is injected per-request (role varies), so we prepare the base
function buildHtml(role) {
  const inject = `<style>#setup{display:none!important}</style>` +
    `<script>window.__GLANCE_SERVED=true;window.__GLANCE_ROLE=${JSON.stringify(role)};` +
    `window.__GLANCE_CONFIG=${JSON.stringify({ type: SOURCE_TYPE, path: SOURCE_PATH })};</script>`;
  return rawHtml.replace('<script>', inject + '<script>');
}

// ── Auth ────────────────────────────────────────────────────
// Returns 'admin', 'viewer', or null (unauthorized)
function authenticate(req) {
  const header = req.headers['authorization'] || '';
  if (!header.startsWith('Basic ')) return null;
  const decoded = Buffer.from(header.slice(6), 'base64').toString();
  const idx = decoded.indexOf(':');
  if (idx === -1) return null;
  const user = decoded.slice(0, idx);
  const pass = decoded.slice(idx + 1);
  if (safeEq(user, ADMIN_USER) && safeEq(pass, ADMIN_PASS)) return 'admin';
  if (safeEq(user, AUTH_USER) && safeEq(pass, AUTH_PASS)) return 'viewer';
  return null;
}

function requireAuth(req, res) {
  const role = authenticate(req);
  if (role) return role;
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="GLance"', 'Content-Type': 'text/plain' });
  res.end('Unauthorized');
  return null;
}

function safeEq(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

// ── Body helper ─────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ── GitLab proxy ────────────────────────────────────────────
const upstreamUrl = new URL(GITLAB_URL);
const upstreamRequest = upstreamUrl.protocol === 'https:' ? https.request : http.request;

function proxy(req, res, targetPath, method) {
  const target = new URL(targetPath, GITLAB_URL);
  const inUrl = new URL(req.url, 'http://localhost');
  inUrl.searchParams.forEach((v, k) => target.searchParams.set(k, v));

  const opts = {
    hostname: target.hostname,
    port: target.port,
    path: target.pathname + target.search,
    method,
    headers: {
      'Authorization': `Bearer ${GITLAB_TOKEN}`,
      'Accept': 'application/json',
    },
  };
  if (req.headers['content-type']) opts.headers['Content-Type'] = req.headers['content-type'];

  const up = upstreamRequest(opts, (upRes) => {
    const fwdHeaders = {};
    for (const h of ['content-type', 'x-total', 'x-total-pages', 'x-page', 'x-per-page', 'x-next-page']) {
      if (upRes.headers[h]) fwdHeaders[h] = upRes.headers[h];
    }
    res.writeHead(upRes.statusCode, fwdHeaders);
    upRes.pipe(res);
  });

  up.on('error', (err) => {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Upstream error: ' + err.message }));
  });

  if (method === 'POST' || method === 'PUT') {
    req.pipe(up);
  } else {
    up.end();
  }
}

// ── Server ──────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const role = requireAuth(req, res);
  if (!role) return;

  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  // Serve index (inject role into config)
  if (p === '/' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(buildHtml(role));
    return;
  }

  // ── Boards API ──────────────────────────────────────────
  if (p === '/api/boards' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(loadBoards()));
    return;
  }
  if (p === '/api/boards' && req.method === 'PUT') {
    if (role !== 'admin') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Admin access required' }));
      return;
    }
    try {
      const body = await readBody(req);
      const boards = JSON.parse(body.toString());
      if (!Array.isArray(boards)) throw new Error('Expected array');
      saveBoards(boards);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── GitLab proxy ────────────────────────────────────────
  // PUT to GitLab (issue label changes) — admin only
  if (p.startsWith('/api/v4/') && req.method === 'PUT') {
    if (role !== 'admin') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Admin access required' }));
      return;
    }
    proxy(req, res, p, 'PUT');
    return;
  }

  // Block DELETE/PATCH for everyone
  if (req.method === 'DELETE' || req.method === 'PATCH') {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not allowed' }));
    return;
  }

  // GET proxy
  if (p.startsWith('/api/v4/') && req.method === 'GET') {
    proxy(req, res, p, 'GET');
    return;
  }
  // GraphQL proxy
  if (p === '/api/graphql' && req.method === 'POST') {
    proxy(req, res, '/api/graphql', 'POST');
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`GLance server running on http://localhost:${PORT}`);
  console.log(`  GitLab:  ${GITLAB_URL}`);
  console.log(`  Source:  ${SOURCE_TYPE} → ${SOURCE_PATH}`);
  console.log(`  Boards:  ${BOARDS_FILE}`);
});
