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

async function startApp() {
  appProc = start(path.join(__dirname, '..', 'src', 'server.js'), appEnv, 'app');
  await waitUp(A);
}

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

  await check('signing up for an item that is in stock -> told now, one email', async () => {
    const r = await request('dan@example.com', 'TEST-A');
    assert.equal((await r.json()).result, 'in_stock');
    await waitFor(async () => accepted(await emailsTo('dan@example.com')).length === 1);
    await sleep(800);
    assert.equal(accepted(await emailsTo('dan@example.com')).length, 1);
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

  console.log(`\nAll ${passed} checks passed.`);
})().catch((e) => { console.error('\nFAILED:', e); process.exitCode = 1; })
  .finally(() => { for (const p of procs) p.kill(); setTimeout(() => fs.rmSync(tmp, { recursive: true, force: true }), 500); });
