const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Client: LdapClient } = require('ldapts');

// ── .env loader ──────────────────────────────────────────────
function loadEnv(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      // Strip surrounding quotes
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {}
}
loadEnv(path.join(__dirname, '.env'));

// ── Config ──────────────────────────────────────────────────
const GITLAB_URL = (process.env.GITLAB_URL || '').replace(/\/$/, '');
const GITLAB_TOKEN = process.env.GITLAB_TOKEN || '';
const SOURCE_TYPE = process.env.SOURCE_TYPE || 'project';
const SOURCE_PATH = process.env.SOURCE_PATH || '';
const LDAP_URL = process.env.LDAP_URL || '';
const LDAP_BIND_DN = process.env.LDAP_BIND_DN || '';
const LDAP_ADMIN_USERS = (process.env.LDAP_ADMIN_USERS || '').split(',').map(s => s.trim()).filter(Boolean);
const PORT = parseInt(process.env.PORT || '3000', 10);
const BOARDS_FILE = path.join(__dirname, 'boards.json');

for (const [k, v] of [['GITLAB_URL', GITLAB_URL], ['GITLAB_TOKEN', GITLAB_TOKEN], ['SOURCE_PATH', SOURCE_PATH], ['LDAP_URL', LDAP_URL], ['LDAP_BIND_DN', LDAP_BIND_DN]]) {
  if (!v) { console.error(`Missing required env var: ${k}`); process.exit(1); }
}

if (!LDAP_BIND_DN.includes('{{username}}')) {
  console.error('LDAP_BIND_DN must contain {{username}} placeholder'); process.exit(1);
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
function buildHtml(role) {
  const inject = `<style>#setup{display:none!important}</style>` +
    `<script>window.__GLANCE_SERVED=true;window.__GLANCE_ROLE=${JSON.stringify(role)};` +
    `window.__GLANCE_CONFIG=${JSON.stringify({ type: SOURCE_TYPE, path: SOURCE_PATH })};</script>`;
  return rawHtml.replace('<script>', inject + '<script>');
}

// ── LDAP Auth ───────────────────────────────────────────────
// Cache successful LDAP binds for 5 minutes to avoid binding on every request
const AUTH_CACHE = new Map();
const AUTH_CACHE_TTL = 5 * 60 * 1000;

async function ldapBind(username, password) {
  const dn = LDAP_BIND_DN.replace('{{username}}', username);
  const client = new LdapClient({ url: LDAP_URL, connectTimeout: 5000 });
  try {
    await client.bind(dn, password);
    return true;
  } finally {
    await client.unbind().catch(() => {});
  }
}

async function authenticate(req) {
  const header = req.headers['authorization'] || '';
  if (!header.startsWith('Basic ')) return null;
  const decoded = Buffer.from(header.slice(6), 'base64').toString();
  const idx = decoded.indexOf(':');
  if (idx === -1) return null;
  const user = decoded.slice(0, idx);
  const pass = decoded.slice(idx + 1);
  if (!user || !pass) return null;

  // Check cache
  const cacheKey = crypto.createHash('sha256').update(user + ':' + pass).digest('hex');
  const cached = AUTH_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.time < AUTH_CACHE_TTL) return cached.role;

  // LDAP bind
  try {
    await ldapBind(user, pass);
  } catch {
    return null;
  }

  const role = LDAP_ADMIN_USERS.includes(user) ? 'admin' : 'viewer';
  AUTH_CACHE.set(cacheKey, { role, time: Date.now() });
  return role;
}

async function requireAuth(req, res) {
  const role = await authenticate(req);
  if (role) return role;
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="GLance"', 'Content-Type': 'text/plain' });
  res.end('Unauthorized');
  return null;
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
  const role = await requireAuth(req, res);
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
  if (p.startsWith('/api/v4/') && req.method === 'PUT') {
    if (role !== 'admin') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Admin access required' }));
      return;
    }
    proxy(req, res, p, 'PUT');
    return;
  }

  if (req.method === 'DELETE' || req.method === 'PATCH') {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not allowed' }));
    return;
  }

  if (p.startsWith('/api/v4/') && req.method === 'GET') {
    proxy(req, res, p, 'GET');
    return;
  }
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
  console.log(`  LDAP:    ${LDAP_URL}`);
  console.log(`  Admins:  ${LDAP_ADMIN_USERS.join(', ') || '(none)'}`);
  console.log(`  Boards:  ${BOARDS_FILE}`);
});
