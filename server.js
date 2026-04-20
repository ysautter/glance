const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

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
const AUTH_METHOD = (process.env.AUTH_METHOD || 'ldap').toLowerCase();
const ADMIN_USERS = (process.env.ADMIN_USERS || '').split(',').map(s => s.trim()).filter(Boolean);
const PORT = parseInt(process.env.PORT || '3000', 10);
const BOARDS_FILE = path.join(__dirname, 'boards.json');
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

// LDAP config
const LDAP_URL = process.env.LDAP_URL || '';
const LDAP_BIND_DN = process.env.LDAP_BIND_DN || '';

// OIDC config
const OIDC_ISSUER_URL = (process.env.OIDC_ISSUER_URL || '').replace(/\/$/, '');
const OIDC_CLIENT_ID = process.env.OIDC_CLIENT_ID || '';
const OIDC_CLIENT_SECRET = process.env.OIDC_CLIENT_SECRET || '';
const OIDC_REDIRECT_URI = process.env.OIDC_REDIRECT_URI || '';
const OIDC_USERNAME_CLAIM = process.env.OIDC_USERNAME_CLAIM || 'preferred_username';

// Validate common config
for (const [k, v] of [['GITLAB_URL', GITLAB_URL], ['GITLAB_TOKEN', GITLAB_TOKEN], ['SOURCE_PATH', SOURCE_PATH]]) {
  if (!v) { console.error(`Missing required env var: ${k}`); process.exit(1); }
}

if (AUTH_METHOD !== 'ldap' && AUTH_METHOD !== 'oidc') {
  console.error('AUTH_METHOD must be "ldap" or "oidc"'); process.exit(1);
}

// Validate auth-specific config
if (AUTH_METHOD === 'ldap') {
  if (!LDAP_URL) { console.error('Missing required env var: LDAP_URL'); process.exit(1); }
  if (!LDAP_BIND_DN) { console.error('Missing required env var: LDAP_BIND_DN'); process.exit(1); }
  if (!LDAP_BIND_DN.includes('{{username}}')) {
    console.error('LDAP_BIND_DN must contain {{username}} placeholder'); process.exit(1);
  }
}
if (AUTH_METHOD === 'oidc') {
  for (const [k, v] of [['OIDC_ISSUER_URL', OIDC_ISSUER_URL], ['OIDC_CLIENT_ID', OIDC_CLIENT_ID], ['OIDC_CLIENT_SECRET', OIDC_CLIENT_SECRET], ['OIDC_REDIRECT_URI', OIDC_REDIRECT_URI]]) {
    if (!v) { console.error(`Missing required env var: ${k}`); process.exit(1); }
  }
}

// ── Boards persistence ──────────────────────────────────────
function loadBoards() {
  try { return JSON.parse(fs.readFileSync(BOARDS_FILE, 'utf-8')); }
  catch { return []; }
}
function saveBoards(boards) {
  fs.writeFileSync(BOARDS_FILE, JSON.stringify(boards, null, 2));
}

// ── Gantt order persistence ─────────────────────────────────
const GANTT_ORDER_FILE = path.join(__dirname, 'gantt-order.json');
function loadGanttOrder() {
  try { return JSON.parse(fs.readFileSync(GANTT_ORDER_FILE, 'utf-8')); }
  catch { return {}; }
}
function saveGanttOrder(order) {
  fs.writeFileSync(GANTT_ORDER_FILE, JSON.stringify(order, null, 2));
}

// ── Prepare index.html with served-mode config ──────────────
const rawHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf-8');
function buildHtml(role, username) {
  const inject = `<style>#setup{display:none!important}</style>` +
    `<script>window.__GLANCE_SERVED=true;window.__GLANCE_ROLE=${JSON.stringify(role)};` +
    `window.__GLANCE_USER=${JSON.stringify(username || '')};` +
    `window.__GLANCE_CONFIG=${JSON.stringify({ type: SOURCE_TYPE, path: SOURCE_PATH })};</script>`;
  return rawHtml.replace('<script>', inject + '<script>');
}

// ── Body / cookie helpers ───────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseCookies(req) {
  const obj = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k) obj[k] = decodeURIComponent(v.join('='));
  }
  return obj;
}

function signSession(data) {
  const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return payload + '.' + sig;
}

function verifySession(token) {
  const [payload, sig] = (token || '').split('.');
  if (!payload || !sig) return null;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try { return JSON.parse(Buffer.from(payload, 'base64url').toString()); }
  catch { return null; }
}

function roleFor(username) {
  return ADMIN_USERS.includes(username) ? 'admin' : 'viewer';
}

// ── LDAP Auth ───────────────────────────────────────────────
const AUTH_CACHE = new Map();
const AUTH_CACHE_TTL = 5 * 60 * 1000;

async function ldapBind(username, password) {
  const { Client: LdapClient } = require('ldapts');
  const dn = LDAP_BIND_DN.replace('{{username}}', username);
  const client = new LdapClient({ url: LDAP_URL, connectTimeout: 5000 });
  try {
    await client.bind(dn, password);
    return true;
  } finally {
    await client.unbind().catch(() => {});
  }
}

async function ldapAuthenticate(req) {
  const header = req.headers['authorization'] || '';
  if (!header.startsWith('Basic ')) return null;
  const decoded = Buffer.from(header.slice(6), 'base64').toString();
  const idx = decoded.indexOf(':');
  if (idx === -1) return null;
  const user = decoded.slice(0, idx);
  const pass = decoded.slice(idx + 1);
  if (!user || !pass) return null;

  const cacheKey = crypto.createHash('sha256').update(user + ':' + pass).digest('hex');
  const cached = AUTH_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.time < AUTH_CACHE_TTL) return { role: cached.role, username: user };

  try { await ldapBind(user, pass); }
  catch { return null; }

  const role = roleFor(user);
  AUTH_CACHE.set(cacheKey, { role, time: Date.now() });
  return { role, username: user };
}

async function ldapRequireAuth(req, res) {
  const auth = await ldapAuthenticate(req);
  if (auth) return auth;
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="GLance"', 'Content-Type': 'text/plain' });
  res.end('Unauthorized');
  return null;
}

// ── OIDC Auth ───────────────────────────────────────────────
let _oidcConfig = null;
async function oidcDiscovery() {
  if (_oidcConfig) return _oidcConfig;
  const r = await fetch(`${OIDC_ISSUER_URL}/.well-known/openid-configuration`);
  if (!r.ok) throw new Error(`OIDC discovery failed: ${r.status}`);
  _oidcConfig = await r.json();
  return _oidcConfig;
}

// OIDC state store (short-lived, for CSRF protection)
const _oidcStates = new Map();

function oidcGetSession(req) {
  const cookies = parseCookies(req);
  return verifySession(cookies.glance_session);
}

async function oidcHandleAuth(req, res, url) {
  const p = url.pathname;

  // Callback from OIDC provider
  if (p === '/auth/callback' && req.method === 'GET') {
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const error = url.searchParams.get('error');

    if (error) {
      res.writeHead(401, { 'Content-Type': 'text/plain' });
      res.end(`Authentication error: ${error} - ${url.searchParams.get('error_description') || ''}`);
      return true;
    }

    if (!code || !state || !_oidcStates.has(state)) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Invalid callback (missing code or state)');
      return true;
    }
    _oidcStates.delete(state);

    try {
      const disc = await oidcDiscovery();
      // Exchange code for tokens
      const tokenRes = await fetch(disc.token_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: OIDC_REDIRECT_URI,
          client_id: OIDC_CLIENT_ID,
          client_secret: OIDC_CLIENT_SECRET,
        }),
      });
      if (!tokenRes.ok) {
        const t = await tokenRes.text();
        throw new Error(`Token exchange failed: ${tokenRes.status} ${t.slice(0, 200)}`);
      }
      const tokens = await tokenRes.json();

      // Decode ID token payload (we trust the provider since we just exchanged the code over TLS)
      const idPayload = JSON.parse(Buffer.from(tokens.id_token.split('.')[1], 'base64url').toString());
      const username = idPayload[OIDC_USERNAME_CLAIM] || idPayload.sub;
      const role = roleFor(username);

      const sessionToken = signSession({ user: username, role, exp: Date.now() + 8 * 60 * 60 * 1000 });
      res.writeHead(302, {
        'Location': '/',
        'Set-Cookie': `glance_session=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=28800`,
      });
      res.end();
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Authentication failed: ' + e.message);
    }
    return true;
  }

  // Logout
  if (p === '/auth/logout' && req.method === 'GET') {
    const disc = await oidcDiscovery();
    let location = '/';
    if (disc.end_session_endpoint) {
      const logoutUrl = new URL(disc.end_session_endpoint);
      logoutUrl.searchParams.set('client_id', OIDC_CLIENT_ID);
      logoutUrl.searchParams.set('post_logout_redirect_uri', OIDC_REDIRECT_URI.replace('/auth/callback', '/'));
      location = logoutUrl.toString();
    }
    res.writeHead(302, {
      'Location': location,
      'Set-Cookie': 'glance_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
    });
    res.end();
    return true;
  }

  return false;
}

async function oidcRequireAuth(req, res) {
  const session = oidcGetSession(req);
  if (session && session.exp > Date.now()) return { role: session.role, username: session.user };

  // Redirect to OIDC provider
  const disc = await oidcDiscovery();
  const state = crypto.randomBytes(16).toString('hex');
  _oidcStates.set(state, Date.now());
  // Clean up old states (> 10 min)
  for (const [k, t] of _oidcStates) { if (Date.now() - t > 600000) _oidcStates.delete(k); }

  const authUrl = new URL(disc.authorization_endpoint);
  authUrl.searchParams.set('client_id', OIDC_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', OIDC_REDIRECT_URI);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'openid profile');
  authUrl.searchParams.set('state', state);

  res.writeHead(302, { 'Location': authUrl.toString() });
  res.end();
  return null;
}

// ── Unified auth interface ──────────────────────────────────
async function requireAuth(req, res, url) {
  if (AUTH_METHOD === 'oidc') {
    // Handle OIDC routes first
    const handled = await oidcHandleAuth(req, res, url);
    if (handled) return '__handled__';
    return oidcRequireAuth(req, res);
  }
  return ldapRequireAuth(req, res);
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
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  // LDAP logout: respond with 401 to clear cached Basic Auth credentials
  if (p === '/auth/logout' && req.method === 'GET' && AUTH_METHOD === 'ldap') {
    res.writeHead(401, {
      'WWW-Authenticate': 'Basic realm="GLance"',
      'Content-Type': 'text/html',
    });
    res.end('<html><body><p>Logged out.</p><p><a href="/">Log in again</a></p></body></html>');
    return;
  }

  const auth = await requireAuth(req, res, url);
  if (!auth) return;
  if (auth === '__handled__') return;
  const { role, username } = auth;

  // Serve index
  if (p === '/' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(buildHtml(role, username));
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

  // ── Gantt order API ─────────────────────────────────────
  if (p === '/api/gantt-order' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(loadGanttOrder()));
    return;
  }
  if (p === '/api/gantt-order' && req.method === 'PUT') {
    if (role !== 'admin') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Admin access required' }));
      return;
    }
    try {
      const body = await readBody(req);
      const order = JSON.parse(body.toString());
      if (typeof order !== 'object' || Array.isArray(order)) throw new Error('Expected object');
      saveGanttOrder(order);
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

// ── Startup ─────────────────────────────────────────────────
(async () => {
  if (AUTH_METHOD === 'oidc') {
    try {
      const disc = await oidcDiscovery();
      console.log(`  OIDC discovered: ${disc.issuer}`);
    } catch (e) {
      console.error(`Failed OIDC discovery: ${e.message}`); process.exit(1);
    }
  }

  server.listen(PORT, () => {
    console.log(`GLance server running on http://localhost:${PORT}`);
    console.log(`  GitLab:  ${GITLAB_URL}`);
    console.log(`  Source:  ${SOURCE_TYPE} → ${SOURCE_PATH}`);
    console.log(`  Auth:    ${AUTH_METHOD.toUpperCase()}${AUTH_METHOD === 'ldap' ? ' → ' + LDAP_URL : ''}`);
    console.log(`  Admins:  ${ADMIN_USERS.join(', ') || '(none)'}`);
    console.log(`  Boards:  ${BOARDS_FILE}`);
  });
})();
