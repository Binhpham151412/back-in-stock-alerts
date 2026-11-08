'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const config = require('./config');
const { db } = require('./db');
const alerts = require('./alerts');
const stock = require('./stock');
const views = require('./views');
const { safeEqual, normSku, validSku } = require('./util');

// ---------- helpers ----------
const BASE_HEADERS = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin' };
function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...BASE_HEADERS, ...headers });
  res.end(body);
}
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400' };
const json = (res, status, obj, headers = {}) => send(res, status, JSON.stringify(obj), { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
const html = (res, body, headers = {}, status = 200) => send(res, status, body, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers });
const redirect = (res, to, headers = {}) => send(res, 303, '', { location: to, ...headers });

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

function readBody(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new HttpError(413, 'Body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
async function readPayload(req) {
  const raw = await readBody(req);
  const type = String(req.headers['content-type'] || '');
  if (type.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(raw));
  try { return raw ? JSON.parse(raw) : {}; } catch { throw new HttpError(400, 'Body must be valid JSON'); }
}

// ---------- admin auth (cookie session, or HTTP Basic for scripts) ----------
const COOKIE = 'restock_admin';
const sessionToken = () => crypto.createHmac('sha256', config.adminPassword).update('restock-admin-session-v1').digest('hex');
function isAdmin(req) {
  if (!config.adminPassword) return false;
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Basic ')) {
    const decoded = Buffer.from(auth.slice(6), 'base64').toString();
    const pass = decoded.slice(decoded.indexOf(':') + 1);
    if (safeEqual(pass, config.adminPassword)) return true;
  }
  const cookie = (req.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith(COOKIE + '='));
  return !!cookie && safeEqual(cookie.slice(COOKIE.length + 1), sessionToken());
}
const secureFlag = (req) => (req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted ? '; Secure' : '');

// ---------- admin data ----------
const STATUSES = ['waiting', 'queued', 'sending', 'notified', 'failed'];
function adminData(filter, search) {
  const stats = { all: 0, waiting: 0, queued: 0, sending: 0, notified: 0, failed: 0 };
  for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM requests GROUP BY status').all()) { stats[r.status] = Number(r.n); stats.all += Number(r.n); }
  const where = []; const args = [];
  if (filter === 'queued') where.push("status IN ('queued','sending')");
  else if (STATUSES.includes(filter)) { where.push('status = ?'); args.push(filter); }
  if (search) { where.push('(email LIKE ? OR sku LIKE ? OR product_name LIKE ?)'); const s = `%${search}%`; args.push(s, s, s); }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = Number(db.prepare(`SELECT COUNT(*) AS n FROM requests ${w}`).get(...args).n);
  const requests = db.prepare(`SELECT * FROM requests ${w} ORDER BY id DESC LIMIT 300`).all(...args);
  const events = db.prepare('SELECT * FROM webhook_events ORDER BY received_at DESC LIMIT 50').all();
  return { stats, requests, total, events, filter: filter || 'all', search: search || '' };
}

// ---------- routes ----------
async function route(req, res) {
  const url = new URL(req.url, 'http://local');
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const m = req.method;
  let mm;

  if (p === '/healthz') return send(res, 200, 'ok');

  if (m === 'OPTIONS' && p.startsWith('/api/')) return send(res, 204, '', CORS);

  if (m === 'GET' && p === '/') {
    const sku = normSku(url.searchParams.get('sku') || 'TEE-ORG-BLK-L');
    let product = validSku(sku) ? { sku, ...(stock.cachedProduct(sku) || {}) } : { sku: 'TEE-ORG-BLK-L' };
    try { if (validSku(sku)) product = await stock.checkStock(sku); } catch { /* show what we have */ }
    return html(res, views.homePage({ product }));
  }

  if (m === 'GET' && p === '/embed') {
    const sku = normSku(url.searchParams.get('sku') || '');
    return html(res, views.embedPage({ sku: validSku(sku) ? sku : '' }), { 'content-security-policy': 'frame-ancestors *' });
  }

  if (m === 'GET' && p === '/api/products') {
    const items = await stock.getCatalogue();
    return json(res, 200, { products: items.map((i) => ({ sku: i.sku, name: i.name, price: i.price, currency: i.currency, image: i.image, in_stock: i.inStock })) }, CORS);
  }
  if (m === 'GET' && (mm = p.match(/^\/api\/products\/([^/]+)$/))) {
    const sku = normSku(decodeURIComponent(mm[1]));
    if (!validSku(sku)) return json(res, 400, { error: 'Invalid SKU' }, CORS);
    try {
      const i = await stock.checkStock(sku);
      return json(res, 200, { sku: i.sku, name: i.name, price: i.price, currency: i.currency, image: i.image, in_stock: i.inStock }, CORS);
    } catch {
      return json(res, 503, { error: 'Product lookup is unavailable right now' }, CORS);
    }
  }

  if (m === 'POST' && p === '/api/requests') {
    const body = await readPayload(req);
    try {
      const out = await alerts.createRequest(body);
      return json(res, out.result === 'already_waiting' ? 200 : 201, { ok: true, ...out }, CORS);
    } catch (e) {
      if (e instanceof alerts.InputError) return json(res, 400, { ok: false, error: e.message }, CORS);
      throw e;
    }
  }

  if (m === 'POST' && p === '/webhooks/stock') {
    if (!config.webhookSecret) return json(res, 500, { ok: false, error: 'WEBHOOK_SECRET is not configured' });
    const given = req.headers['x-webhook-secret'];
    if (typeof given !== 'string' || !safeEqual(given, config.webhookSecret)) {
      req.resume();
      return json(res, 401, { ok: false, error: 'Invalid webhook secret' });
    }
    const body = await readPayload(req);
    try {
      const out = await alerts.handleWebhook(body);
      return json(res, out.status, out.body);
    } catch (e) {
      if (e instanceof alerts.InputError) return json(res, 400, { ok: false, error: e.message });
      throw e;
    }
  }

  if (p === '/admin' || p.startsWith('/admin/')) {
    const adminHeaders = { 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'" };
    if (!config.adminPassword) return send(res, 503, 'Set ADMIN_PASSWORD to enable the admin page.');
    if (m === 'POST' && p === '/admin/login') {
      const f = await readPayload(req);
      if (safeEqual(String(f.password || ''), config.adminPassword)) {
        return redirect(res, '/admin', { 'set-cookie': `${COOKIE}=${sessionToken()}; Path=/admin; HttpOnly; SameSite=Lax; Max-Age=604800${secureFlag(req)}` });
      }
      await new Promise((r) => setTimeout(r, 600)); // slow down guessing
      return html(res, views.adminLogin({ error: 'That password is not right.' }), adminHeaders, 401);
    }
    if (m === 'POST' && p === '/admin/logout') {
      return redirect(res, '/admin', { 'set-cookie': `${COOKIE}=; Path=/admin; HttpOnly; SameSite=Lax; Max-Age=0${secureFlag(req)}` });
    }
    if (!isAdmin(req)) {
      if (m === 'GET' && p === '/admin') return html(res, views.adminLogin(), adminHeaders, 401);
      return json(res, 401, { error: 'Authentication required' }, { 'www-authenticate': 'Basic realm="admin"' });
    }
    const filter = url.searchParams.get('status') || 'all';
    const search = (url.searchParams.get('q') || '').trim().slice(0, 100);
    if (m === 'GET' && p === '/admin') return html(res, views.adminPage(adminData(filter, search)), adminHeaders);
    if (m === 'GET' && p === '/admin/requests.json') {
      const d = adminData(filter, search);
      return json(res, 200, { stats: d.stats, total: d.total, requests: d.requests, webhook_events: d.events });
    }
  }

  return json(res, 404, { error: 'Not found' });
}

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    if (e instanceof HttpError) { if (!res.headersSent) json(res, e.status, { ok: false, error: e.message }); return; }
    console.error('[http]', e);
    if (!res.headersSent) json(res, 500, { ok: false, error: 'Internal error' });
  });
});

server.listen(config.port, () => {
  console.log(`Back-in-stock alerts listening on :${config.port}`);
  const missing = ['STOCK_API_URL', 'STOCK_API_KEY', 'RESEND_API_KEY', 'RESEND_BASE_URL', 'WEBHOOK_SECRET', 'ADMIN_PASSWORD'].filter((k) => !process.env[k]);
  if (missing.length) console.warn(`Missing env: ${missing.join(', ')}`);
  alerts.start();
});

function shutdown(sig) {
  console.log(`${sig}: shutting down`);
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
