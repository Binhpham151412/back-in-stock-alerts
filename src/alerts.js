'use strict';
// Core logic: sign-ups, webhook handling, the durable email queue and the reconciler.
//
// One email per request, in short (see the README for the exact guarantee and its limits):
//  - A request moves waiting -> queued -> sending -> notified with guarded UPDATEs
//    (`WHERE status = 'waiting'` etc.), so it can be claimed once no matter how many
//    webhooks, retries or reconcile passes try at the same time.
//  - Nothing is queued until the stock API confirms quantity > 0 (webhooks can lie).
//  - Webhook event_ids are recorded before any await, so a duplicate delivery that
//    arrives at the same moment is recognised and acknowledged without side effects.
//  - The email queue is in SQLite, so a restart resumes it. Before the first send, the
//    exact request (Idempotency-Key + JSON body) is stored; every retry, including after a
//    restart, resends those same bytes, so the provider can deduplicate a send whose
//    response was lost. Later product or config changes don't touch a frozen payload.
//  - Failed sends are retried with backoff; a periodic reconcile pass re-checks stock for
//    SKUs that still have people waiting, in case a webhook never arrived.
const config = require('./config');
const { db } = require('./db');
const stock = require('./stock');
const { buildOutbound, sendFrozen } = require('./email');
const { now, normEmail, normSku, validEmail, validSku, validUrl } = require('./util');

const OPEN = "('waiting','queued','sending')";

const q = {
  insertRequest: db.prepare(`INSERT INTO requests (email, sku, page_url, created_at, product_name, product_image, product_price, product_currency)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`),
  openRequest: db.prepare(`SELECT * FROM requests WHERE email = ? AND sku = ? AND status IN ${OPEN}`),
  getRequest: db.prepare('SELECT * FROM requests WHERE id = ?'),
  setProduct: db.prepare(`UPDATE requests SET product_name = COALESCE(?, product_name), product_image = COALESCE(?, product_image),
    product_price = COALESCE(?, product_price), product_currency = COALESCE(?, product_currency)
    WHERE sku = ? AND status IN ('waiting','queued') AND email_body IS NULL`),
  // Freeze the exact request once, before the first network call. Never overwritten.
  freeze: db.prepare(`UPDATE requests SET email_idem_key = ?, email_body = ?, email_frozen_at = ? WHERE id = ? AND email_body IS NULL`),
  queueSku: db.prepare(`UPDATE requests SET status = 'queued', queued_at = ?, next_attempt_at = ?, trigger = ?
    WHERE sku = ? AND status = 'waiting'`),
  closeInStock: db.prepare(`UPDATE requests SET status = 'in_stock', trigger = ? WHERE id = ? AND status = 'waiting'`),
  due: db.prepare(`SELECT id FROM requests WHERE status = 'queued' AND next_attempt_at <= ? ORDER BY id LIMIT 50`),
  claim: db.prepare(`UPDATE requests SET status = 'sending', attempts = attempts + 1 WHERE id = ? AND status = 'queued'`),
  markSent: db.prepare(`UPDATE requests SET status = 'notified', notified_at = ?, email_id = ?, last_error = NULL WHERE id = ? AND status = 'sending'`),
  markRetry: db.prepare(`UPDATE requests SET status = 'queued', next_attempt_at = ?, last_error = ? WHERE id = ? AND status = 'sending'`),
  markFailed: db.prepare(`UPDATE requests SET status = 'failed', last_error = ? WHERE id = ? AND status = 'sending'`),
  recoverSending: db.prepare(`UPDATE requests SET status = 'queued', next_attempt_at = ? WHERE status = 'sending'`),
  waitingSkus: db.prepare(`SELECT DISTINCT sku FROM requests WHERE status = 'waiting'`),
  getEvent: db.prepare('SELECT * FROM webhook_events WHERE event_id = ?'),
  insertEvent: db.prepare(`INSERT INTO webhook_events (event_id, sku, quantity, status, received_at) VALUES (?, ?, ?, 'processing', ?)`),
  bumpEvent: db.prepare('UPDATE webhook_events SET deliveries = deliveries + 1 WHERE event_id = ?'),
  retryEvent: db.prepare(`UPDATE webhook_events SET status = 'processing', deliveries = deliveries + 1 WHERE event_id = ? AND status = 'unverified'`),
  finishEvent: db.prepare(`UPDATE webhook_events SET status = ?, verified_qty = ?, queued = ?, processed_at = ?, note = ? WHERE event_id = ?`),
};

class InputError extends Error {}

function rememberProduct(p) {
  if (p && (p.name || p.image)) q.setProduct.run(p.name, p.image, p.price, p.currency, p.sku);
}

function queueSku(sku, trigger) {
  const t = now();
  const n = Number(q.queueSku.run(t, t, trigger, sku).changes);
  if (n) kick();
  return n;
}

// ---- sign-ups ----
async function createRequest(body) {
  const email = normEmail(body && body.email);
  const sku = normSku(body && body.sku);
  if (!validEmail(email)) throw new InputError('Please enter a valid email address.');
  if (!validSku(sku)) throw new InputError('Please enter a valid SKU.');
  const pageUrl = body && body.page_url ? validUrl(body.page_url) : null;

  const cached = stock.cachedProduct(sku);
  const ins = q.insertRequest.run(email, sku, pageUrl, now(), cached?.name ?? null, cached?.image ?? null, cached?.price ?? null, cached?.currency ?? null);
  if (!Number(ins.changes)) {
    return { result: 'already_waiting', request: publicRequest(q.openRequest.get(email, sku)) };
  }
  const id = Number(ins.lastInsertRowid);

  // If it's in stock right now there's nothing to wait for: say so on screen and close the
  // request without an email. (Emailing here would let someone who submits the form twice
  // while the item is in stock get two emails.) Checking after the insert also covers a
  // restock webhook processed a moment before this sign-up.
  let result = 'waiting';
  try {
    const p = await stock.checkStock(sku);
    rememberProduct(p);
    if (p.inStock && Number(q.closeInStock.run('in stock at sign-up: shown on screen, no email needed', id).changes)) {
      result = 'in_stock';
    }
  } catch (e) {
    console.warn(`[request] stock check failed for ${sku}, the reconciler will retry: ${e.message}`);
  }
  return { result, request: publicRequest(q.getRequest.get(id)) };
}

function publicRequest(r) {
  if (!r) return null;
  return {
    id: r.id, email: r.email, sku: r.sku, status: r.status, created_at: r.created_at, notified_at: r.notified_at,
    product: r.product_name ? { name: r.product_name, image: r.product_image, price: r.product_price, currency: r.product_currency } : null,
  };
}

// ---- webhooks ----
async function handleWebhook(body) {
  const eventId = body && typeof body.event_id === 'string' ? body.event_id.trim() : '';
  const sku = normSku(body && body.sku);
  if (!eventId || eventId.length > 200) throw new InputError('event_id is required');
  if (!validSku(sku)) throw new InputError('sku is invalid');
  const hint = Number(body.quantity);

  // Synchronous claim of the event id: no await before this point, so concurrent
  // duplicate deliveries are serialised by the event loop and the primary key.
  const existing = q.getEvent.get(eventId);
  if (existing) {
    if (!Number(q.retryEvent.run(eventId).changes)) {
      q.bumpEvent.run(eventId);
      return { status: 200, body: { ok: true, duplicate: true, event_id: eventId, outcome: existing.status } };
    }
  } else {
    q.insertEvent.run(eventId, sku, Number.isFinite(hint) ? hint : null, now());
  }

  if (!(hint > 0)) {
    q.finishEvent.run('sellout', null, 0, now(), 'quantity is 0: nothing to send', eventId);
    return { status: 200, body: { ok: true, event_id: eventId, outcome: 'sellout' } };
  }

  let p;
  try {
    p = await stock.checkStock(sku);
  } catch (e) {
    // We couldn't verify. Don't email on an unverified claim; ask the sender to retry
    // (a redelivery of this event id is processed again) and let the reconciler cover it.
    q.finishEvent.run('unverified', null, 0, now(), `stock API unavailable: ${e.message}`, eventId);
    return { status: 503, body: { ok: false, event_id: eventId, outcome: 'unverified', retry: true } };
  }
  rememberProduct(p);
  if (!p.inStock) {
    q.finishEvent.run('phantom', p.quantity, 0, now(), `webhook said ${hint}, stock API says ${p.quantity}`, eventId);
    return { status: 200, body: { ok: true, event_id: eventId, outcome: 'ignored', reason: 'stock API does not confirm a restock' } };
  }
  const queued = queueSku(sku, `webhook ${eventId}`);
  q.finishEvent.run('confirmed', p.quantity, queued, now(), null, eventId);
  return { status: 200, body: { ok: true, event_id: eventId, outcome: 'confirmed', queued } };
}

// ---- email queue ----
let running = false;
let again = false;

function kick() {
  if (running) { again = true; return; }
  running = true;
  processQueue()
    .catch((e) => console.error('[queue]', e))
    .finally(() => { running = false; if (again) { again = false; kick(); } });
}

async function processQueue() {
  for (;;) {
    const due = q.due.all(now());
    if (!due.length) return;
    for (const { id } of due) {
      if (!Number(q.claim.run(id).changes)) continue;
      let r = q.getRequest.get(id);
      if (!r.email_body) {
        const out = buildOutbound(r);
        q.freeze.run(out.key, out.body, now(), id);
        r = q.getRequest.get(id);
      }
      const res = await sendFrozen({ key: r.email_idem_key, body: r.email_body });
      if (res.ok) {
        q.markSent.run(now(), res.id, id);
        console.log(`[queue] notified ${r.email} about ${r.sku} (request ${id})`);
      } else if (r.attempts >= config.maxEmailAttempts) {
        q.markFailed.run(res.error, id);
        console.error(`[queue] giving up on request ${id} after ${r.attempts} attempts: ${res.error}`);
      } else {
        const delay = Math.min(3000 * 2 ** (r.attempts - 1), 10 * 60_000);
        q.markRetry.run(new Date(Date.now() + delay).toISOString(), res.error, id);
        console.warn(`[queue] send failed for request ${id} (attempt ${r.attempts}), retrying in ${delay / 1000}s: ${res.error}`);
      }
    }
  }
}

// ---- reconciler ----
let reconciling = false;
async function reconcile() {
  if (reconciling || !config.stockApiUrl) return;
  reconciling = true;
  try {
    for (const { sku } of q.waitingSkus.all()) {
      try {
        const p = await stock.checkStock(sku);
        rememberProduct(p);
        if (p.inStock) {
          const n = queueSku(sku, 'reconcile: stock API shows it in stock');
          if (n) console.log(`[reconcile] ${sku} is in stock, queued ${n} alert(s)`);
        }
      } catch (e) {
        console.warn(`[reconcile] ${sku}: ${e.message}`);
      }
    }
  } finally {
    reconciling = false;
  }
}

function start() {
  // Anything mid-send when we last stopped goes back on the queue; the idempotency key
  // makes the resend safe if the first attempt actually got through.
  const n = Number(q.recoverSending.run(now()).changes);
  if (n) console.log(`[queue] recovered ${n} in-flight send(s) after restart`);
  kick();
  setInterval(kick, 2000).unref();
  setTimeout(reconcile, 5000).unref();
  setInterval(reconcile, config.reconcileSeconds * 1000).unref();
}

module.exports = { createRequest, handleWebhook, start, InputError, publicRequest, reconcile };
