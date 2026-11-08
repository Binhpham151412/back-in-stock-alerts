'use strict';
// End-to-end test against the challenge's own test server, run locally.
//   HARNESS=/path/to/back-in-stock-challenge/harness/server.js node test/e2e.js
// Starts the harness and this app on spare ports with throwaway data dirs, then checks:
// webhook auth, duplicate requests, phantom restocks, duplicate concurrent webhooks,
// email failures + retry, in-stock-at-signup, sell-outs, crash/restart recovery, admin, embed.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const HARNESS = process.env.HARNESS || path.join(__dirname, '..', '..', '_ref', 'back-in-stock-challenge', 'harness', 'server.js');
const H_PORT = 4310, A_PORT = 4320;
const H = `http://localhost:${H_PORT}`, A = `http://localhost:${A_PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bis-e2e-'));
const hData = path.join(tmp, 'harness'), aData = path.join(tmp, 'app');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = [];
let passed = 0;

function start(file, env, name) {
  const p = spawn(process.execPath, [file], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', (d) => process.env.VERBOSE && process.stdout.write(`[${name}] ${d}`));
  p.stderr.on('data', (d) => process.env.VERBOSE && process.stderr.write(`[${name}] ${d}`));
  procs.push(p);
  return p;
}
async function waitUp(url) {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(url + '/healthz')).ok) return; } catch {} await sleep(100); }
  throw new Error('not up: ' + url);
}
const form = (o) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o).toString(), redirect: 'manual' });
const post = (url, body, headers = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
async function check(name, fn) { await fn(); passed++; console.log(`  ✓ ${name}`); }

let cand, appProc, appEnv;
const harnessDb = () => JSON.parse(fs.readFileSync(path.join(hData, 'db.json'), 'utf8')).candidates[cand.id];
async function emailsTo(addr) { await sleep(400); return harnessDb().emails.filter((e) => e.to.includes(addr)); }
const accepted = (list) => list.filter((e) => e.status === 'accepted');
const testApi = (action, body) => post(`${H}/api/test/${action}`, body, { authorization: `Bearer ${cand.apiKey}` }).then((r) => r.json());
const setStock = (sku, quantity) => fetch(`${H}/c/${cand.token}/stock`, form({ sku, quantity }));
const failNext = (n) => fetch(`${H}/c/${cand.token}/fail`, form({ n }));
const request = (email, sku) => post(`${A}/api/requests`, { email, sku });
const admin = { authorization: 'Basic ' + Buffer.from('admin:test-admin-pw').toString('base64') };
const adminJson = () => fetch(`${A}/admin/requests.json`, { headers: admin }).then((r) => r.json());
async function waitFor(fn, ms = 20000) { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) return v; await sleep(300); } }

async function startApp(extraEnv = {}) {
  appProc = start(path.join(__dirname, '..', 'src', 'server.js'), { ...appEnv, ...extraEnv }, 'app');
  await waitUp(A);
}
async function stopApp() {
  const exited = new Promise((r) => appProc.once('exit', r));
  appProc.kill('SIGKILL');
  await exited;
}

// A proxy in front of the test server, so tests can lose the email API's response after the
// email was accepted. mode: 'pass' | 'drop' (accept upstream, then cut the connection)
// | 'hold' (accept upstream, never answer).
const P_PORT = 4330, P = `http://localhost:${P_PORT}`;
const proxy = { mode: 'pass', sent: [], held: [] };
const proxyServer = require('node:http').createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks).toString('utf8');
  const headers = {};
  for (const h of ['authorization', 'content-type', 'idempotency-key']) if (req.headers[h]) headers[h] = req.headers[h];
  const up = await fetch(H + req.url, { method: req.method, headers, body: req.method === 'GET' ? undefined : body });
  const upBody = await up.text();
  if (req.url.startsWith('/emails')) {
    proxy.sent.push({ key: req.headers['idempotency-key'], body, upstream: up.status });
    if (proxy.mode === 'drop') { req.socket.destroy(); return; }
    if (proxy.mode === 'hold') { proxy.held.push(res); return; }
  }
  res.writeHead(up.status, { 'content-type': up.headers.get('content-type') || 'application/json' });
  res.end(upBody);
});
const viaProxy = { STOCK_API_URL: `${P}/api/stock`, RESEND_BASE_URL: P };
const sentTo = (addr) => proxy.sent.filter((s) => JSON.parse(s.body).to.includes(addr));

(async () => {
  start(HARNESS, { PORT: H_PORT, DATA_DIR: hData, SIM_INTERVAL_SECONDS: '100000', INVITE_CODE: '' }, 'harness');
  await waitUp(H);
  const signup = await fetch(`${H}/signup`, form({ name: 'e2e' }));
  const token = signup.headers.get('location').split('/c/')[1];
  await sleep(400);
  cand = Object.values(JSON.parse(fs.readFileSync(path.join(hData, 'db.json'), 'utf8')).candidates).find((c) => c.token === token);
  await fetch(`${H}/c/${token}/baseurl`, form({ baseUrl: A }));
  await fetch(`${H}/c/${token}/sim`, form({ action: 'stop' }));
  for (const s of ['TEST-A', 'TEST-B', 'TEST-C', 'TEST-D']) await setStock(s, 0);

  appEnv = {
    PORT: A_PORT, DATA_DIR: aData, STOCK_API_URL: `${H}/api/stock`, STOCK_API_KEY: cand.apiKey,
    RESEND_API_KEY: cand.apiKey, RESEND_BASE_URL: H, WEBHOOK_SECRET: cand.webhookSecret, ADMIN_PASSWORD: 'test-admin-pw',
  };
  await startApp();
  console.log('Running e2e against local harness');

  await check('webhook with wrong secret is rejected (401)', async () => {
    const r = await post(`${A}/webhooks/stock`, { event_id: 'evt_x', sku: 'TEST-A', quantity: 5 }, { 'x-webhook-secret': 'nope' });
    assert.equal(r.status, 401);
    const r2 = await post(`${A}/webhooks/stock`, { event_id: 'evt_x', sku: 'TEST-A', quantity: 5 });
    assert.equal(r2.status, 401);
  });

  await check('request is created, normalised, and not duplicated', async () => {
    const r1 = await request('  Ann@Example.com ', 'test-a');
    assert.equal(r1.status, 201); assert.equal((await r1.json()).result, 'waiting');
    const r2 = await request('ann@example.com', 'TEST-A');
    assert.equal(r2.status, 200); assert.equal((await r2.json()).result, 'already_waiting');
    const burst = await Promise.all(Array.from({ length: 6 }, () => request('bob@example.com', 'TEST-A')));
    assert.equal(burst.filter((r) => r.status === 201).length, 1);
    const d = await adminJson();
    assert.equal(d.requests.filter((r) => r.sku === 'TEST-A').length, 2);
  });

  await check('invalid input is rejected (400)', async () => {
    assert.equal((await request('not-an-email', 'TEST-A')).status, 400);
    assert.equal((await request('x@example.com', '')).status, 400);
    const r = await fetch(`${A}/api/requests`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' });
    assert.equal(r.status, 400);
  });

  await check('phantom restock (stock API says 0) sends nothing', async () => {
    const out = await testApi('phantom', { sku: 'TEST-A', quantity: 12 });
    assert.deepEqual(out.deliveries, [200]);
    await sleep(1500);
    assert.equal((await emailsTo('ann@example.com')).length, 0);
    assert.equal((await adminJson()).webhook_events.find((e) => e.event_id === out.event_id).status, 'phantom');
  });

  await check('restock delivered twice at once -> exactly one email per customer', async () => {
    const out = await testApi('restock', { sku: 'TEST-A', quantity: 5, twice: true });
    assert.equal(out.deliveries.length, 2); assert.ok(out.deliveries.every((s) => s === 200));
    await waitFor(async () => accepted(await emailsTo('bob@example.com')).length === 1);
    await sleep(1500);
    assert.equal(accepted(await emailsTo('ann@example.com')).length, 1);
    assert.equal(accepted(await emailsTo('bob@example.com')).length, 1);
    // A manual redelivery of the same event later is also ignored.
    const again = await post(`${A}/webhooks/stock`, { event_id: out.event_id, sku: 'TEST-A', quantity: 5 }, { 'x-webhook-secret': cand.webhookSecret });
    assert.equal((await again.json()).duplicate, true);
    await sleep(800);
    assert.equal(accepted(await emailsTo('ann@example.com')).length, 1);
    const ann = (await adminJson()).requests.find((r) => r.email === 'ann@example.com');
    assert.equal(ann.status, 'notified'); assert.ok(ann.notified_at);
  });

  await check('email API returns 500 twice -> retried, delivered exactly once', async () => {
    await request('cara@example.com', 'TEST-B');
    await failNext(2);
    await testApi('restock', { sku: 'TEST-B', quantity: 3, twice: false });
    const ok = await waitFor(async () => accepted(await emailsTo('cara@example.com')).length === 1, 25000);
    assert.ok(ok, 'cara never got her email');
    await sleep(1000);
    const list = await emailsTo('cara@example.com');
    assert.equal(accepted(list).length, 1);
    assert.equal(list.filter((e) => e.status.startsWith('failed')).length, 2);
    const r = (await adminJson()).requests.find((x) => x.email === 'cara@example.com');
    assert.equal(r.status, 'notified'); assert.equal(r.attempts, 3);
  });

  await check('signing up while in stock -> told on screen, no email, even when repeated', async () => {
    for (let i = 0; i < 4; i++) {
      const r = await request('dan@example.com', 'TEST-A');
      assert.equal(r.status, 201); assert.equal((await r.json()).result, 'in_stock');
    }
    await sleep(2500);
    assert.equal((await emailsTo('dan@example.com')).length, 0);
    const rows = (await adminJson()).requests.filter((x) => x.email === 'dan@example.com');
    assert.ok(rows.length && rows.every((x) => x.status === 'in_stock'));
  });

  await check('sell-out webhook (quantity 0) is acknowledged, no emails', async () => {
    await request('eve@example.com', 'TEST-D');
    const out = await testApi('sellout', { sku: 'TEST-D' });
    assert.deepEqual(out.deliveries, [200]);
    await sleep(800);
    assert.equal((await emailsTo('eve@example.com')).length, 0);
  });

  await check('crash with a send pending -> restart resumes it, one email', async () => {
    await request('finn@example.com', 'TEST-C');
    await failNext(1);
    await testApi('restock', { sku: 'TEST-C', quantity: 4, twice: false });
    await waitFor(async () => (await emailsTo('finn@example.com')).length === 1);
    appProc.kill('SIGKILL');
    await sleep(500);
    await startApp();
    const ok = await waitFor(async () => accepted(await emailsTo('finn@example.com')).length === 1, 20000);
    assert.ok(ok, 'finn never got his email after restart');
    await sleep(1000);
    assert.equal(accepted(await emailsTo('finn@example.com')).length, 1);
    const d = await adminJson();
    assert.equal(d.requests.find((x) => x.email === 'eve@example.com').status, 'waiting', 'data survived restart');
  });

  await check('admin is password protected', async () => {
    const anon = await fetch(`${A}/admin`);
    assert.equal(anon.status, 401);
    assert.match(await anon.text(), /Admin sign in/);
    assert.equal((await fetch(`${A}/admin/requests.json`)).status, 401);
    const bad = await fetch(`${A}/admin/login`, form({ password: 'wrong' }));
    assert.equal(bad.status, 401);
    const good = await fetch(`${A}/admin/login`, form({ password: 'test-admin-pw' }));
    assert.equal(good.status, 303);
    const cookie = good.headers.get('set-cookie').split(';')[0];
    const page = await fetch(`${A}/admin`, { headers: { cookie } });
    assert.equal(page.status, 200);
    const text = await page.text();
    assert.match(text, /ann@example.com/); assert.match(text, /Notified/);
  });

  await check('embed is frameable and the email looks like the brief asks', async () => {
    const r = await fetch(`${A}/embed?sku=TEST-A`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-frame-options'), null);
    assert.match(r.headers.get('content-security-policy'), /frame-ancestors \*/);
    const mail = accepted(await emailsTo('ann@example.com'))[0];
    assert.match(mail.html, /viewport/); assert.ok(mail.text.length > 0); assert.match(mail.subject, /back/i);
    assert.ok(mail.idempotencyKey);
  });

  // ---- lost responses: the email API accepted the email but the app never heard back ----
  await new Promise((r) => proxyServer.listen(P_PORT, r));
  await stopApp();
  await startApp(viaProxy);

  await check('email accepted but response lost -> retry reuses key + payload, one email', async () => {
    await setStock('TEST-F', 0);
    await request('hana@example.com', 'TEST-F');
    proxy.mode = 'drop';
    await testApi('restock', { sku: 'TEST-F', quantity: 2, twice: false });
    await waitFor(() => sentTo('hana@example.com').length >= 1);
    proxy.mode = 'pass';
    const ok = await waitFor(async () => (await adminJson()).requests.find((x) => x.email === 'hana@example.com').status === 'notified', 20000);
    assert.ok(ok, 'hana was never marked notified');
    const sends = sentTo('hana@example.com');
    assert.equal(sends.length, 2, 'expected the original send and one retry');
    assert.equal(sends[0].key, sends[1].key); assert.equal(sends[0].body, sends[1].body);
    const inbox = await emailsTo('hana@example.com');
    assert.equal(accepted(inbox).length, 1);
    assert.equal(inbox.filter((e) => e.status.startsWith('deduped')).length, 1);
  });

  await check('crash before markSent + product/config changed while down -> same key + payload, one email', async () => {
    await setStock('TEST-E', 0);
    await request('gina@example.com', 'TEST-E');
    proxy.mode = 'hold';
    await testApi('restock', { sku: 'TEST-E', quantity: 2, twice: false });
    await waitFor(async () => accepted(await emailsTo('gina@example.com')).length === 1);
    await stopApp(); // dies while still waiting for the email API's response
    proxy.held.splice(0).forEach((res) => res.destroy());
    proxy.mode = 'pass';

    // While it's down: the request is mid-send with its payload already frozen; the product
    // details change, and the app comes back with a different sender and brand.
    const { DatabaseSync } = require('node:sqlite');
    const sdb = new DatabaseSync(path.join(aData, 'restock.db'));
    const row = sdb.prepare("SELECT * FROM requests WHERE email = 'gina@example.com'").get();
    assert.equal(row.status, 'sending'); assert.ok(row.email_body && row.email_idem_key, 'payload frozen before the first send');
    sdb.prepare("UPDATE requests SET product_name = 'Renamed While Down', product_price = 999 WHERE id = ?").run(row.id);
    sdb.close();
    await startApp({ ...viaProxy, BRAND_NAME: 'Rebranded', EMAIL_FROM: 'Changed <changed@example.com>' });

    const ok = await waitFor(async () => (await adminJson()).requests.find((x) => x.email === 'gina@example.com').status === 'notified', 20000);
    assert.ok(ok, 'gina was never marked notified after restart');
    const sends = sentTo('gina@example.com');
    assert.equal(sends.length, 2, 'expected the original send and one resend after restart');
    assert.equal(sends[0].key, sends[1].key); assert.equal(sends[0].body, sends[1].body);
    assert.doesNotMatch(sends[1].body, /Renamed While Down|Rebranded|changed@example/);
    const inbox = await emailsTo('gina@example.com');
    assert.equal(accepted(inbox).length, 1);
    assert.equal(inbox.filter((e) => e.status.startsWith('deduped')).length, 1);
  });

  await check('a database from the previous version is migrated in place', async () => {
    const oldDir = path.join(tmp, 'old-db');
    fs.mkdirSync(oldDir);
    const { DatabaseSync } = require('node:sqlite');
    const odb = new DatabaseSync(path.join(oldDir, 'restock.db'));
    odb.exec(`CREATE TABLE requests (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, sku TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'waiting', product_name TEXT, product_image TEXT, product_price REAL, product_currency TEXT,
      page_url TEXT, created_at TEXT NOT NULL, queued_at TEXT, notified_at TEXT, trigger TEXT, attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT, last_error TEXT, email_id TEXT);
      INSERT INTO requests (email, sku, created_at) VALUES ('old@example.com', 'TEST-OLD', '2026-01-01T00:00:00.000Z');`);
    odb.close();
    const M = 'http://localhost:4340';
    const p = start(path.join(__dirname, '..', 'src', 'server.js'), { ...appEnv, PORT: 4340, DATA_DIR: oldDir }, 'migrate');
    await waitUp(M);
    const d = await fetch(`${M}/admin/requests.json`, { headers: admin }).then((r) => r.json());
    p.kill();
    assert.equal(d.requests[0].email, 'old@example.com');
    assert.ok(['email_idem_key', 'email_body', 'email_frozen_at'].every((c) => c in d.requests[0]));
  });
  await check('a fresh database (e.g. a redeploy) never reuses an earlier idempotency key', async () => {
    // Request ids restart at 1 in a new database; the earlier app already emailed request #1.
    const F = 'http://localhost:4350';
    const p = start(path.join(__dirname, '..', 'src', 'server.js'), { ...appEnv, PORT: 4350, DATA_DIR: path.join(tmp, 'fresh-db') }, 'fresh');
    await waitUp(F);
    await setStock('TEST-G', 0);
    const r = await post(`${F}/api/requests`, { email: 'zed@example.com', sku: 'TEST-G' });
    const out = await r.json();
    assert.equal(out.request.id, 1); assert.equal(out.result, 'waiting');
    await setStock('TEST-G', 3);
    const hook = await post(`${F}/webhooks/stock`, { event_id: 'evt_fresh_db', sku: 'TEST-G', quantity: 3 }, { 'x-webhook-secret': cand.webhookSecret });
    assert.equal((await hook.json()).outcome, 'confirmed');
    const ok = await waitFor(async () => (await emailsTo('zed@example.com')).length >= 1);
    p.kill();
    assert.ok(ok, 'zed never got an email');
    const inbox = await emailsTo('zed@example.com');
    assert.equal(accepted(inbox).length, 1, `expected an accepted email, got: ${inbox.map((e) => e.status).join(', ')}`);
  });
  proxyServer.close();

  console.log(`\nAll ${passed} checks passed.`);
})().catch((e) => { console.error('\nFAILED:', e); process.exitCode = 1; })
  .finally(() => { for (const p of procs) p.kill(); setTimeout(() => fs.rmSync(tmp, { recursive: true, force: true }), 500); });
