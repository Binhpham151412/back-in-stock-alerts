'use strict';
// SQLite via Node's built-in driver: no native deps, synchronous, durable (WAL).
// Everything that matters (requests, the email queue, webhook events) lives here,
// so a restart picks up exactly where it left off.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

fs.mkdirSync(config.dataDir, { recursive: true });
const db = new DatabaseSync(path.join(config.dataDir, 'restock.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS requests (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  email           TEXT NOT NULL,
  sku             TEXT NOT NULL,
  -- waiting -> queued -> sending -> notified   (or failed after max attempts)
  status          TEXT NOT NULL DEFAULT 'waiting',
  product_name    TEXT,
  product_image   TEXT,
  product_price   REAL,
  product_currency TEXT,
  page_url        TEXT,
  created_at      TEXT NOT NULL,
  queued_at       TEXT,
  notified_at     TEXT,
  trigger         TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error      TEXT,
  email_id        TEXT,
  -- The exact email request (key + JSON body), frozen before the first send attempt.
  email_idem_key  TEXT,
  email_body      TEXT,
  email_frozen_at TEXT
);
-- The rule "no duplicate open requests" is enforced by the database, not by app code.
CREATE UNIQUE INDEX IF NOT EXISTS requests_one_open
  ON requests(email, sku) WHERE status IN ('waiting', 'queued', 'sending');
CREATE INDEX IF NOT EXISTS requests_sku_status ON requests(sku, status);
CREATE INDEX IF NOT EXISTS requests_status_next ON requests(status, next_attempt_at);

CREATE TABLE IF NOT EXISTS webhook_events (
  event_id     TEXT PRIMARY KEY,
  sku          TEXT NOT NULL,
  quantity     INTEGER,
  -- processing | confirmed | phantom | sellout | unverified
  status       TEXT NOT NULL,
  verified_qty INTEGER,
  queued       INTEGER NOT NULL DEFAULT 0,
  deliveries   INTEGER NOT NULL DEFAULT 1,
  received_at  TEXT NOT NULL,
  processed_at TEXT,
  note         TEXT
);
CREATE INDEX IF NOT EXISTS webhook_events_received ON webhook_events(received_at);
`);

// Additive migrations for databases created by earlier versions.
const requestCols = new Set(db.prepare('PRAGMA table_info(requests)').all().map((c) => c.name));
for (const [col, type] of [['email_idem_key', 'TEXT'], ['email_body', 'TEXT'], ['email_frozen_at', 'TEXT']]) {
  if (!requestCols.has(col)) db.exec(`ALTER TABLE requests ADD COLUMN ${col} ${type}`);
}

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

module.exports = { db, tx };
