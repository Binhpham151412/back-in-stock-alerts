'use strict';
const crypto = require('node:crypto');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const now = () => new Date().toISOString();

const SYMBOLS = { GBP: '£', USD: '$', EUR: '€' };
function money(amount, currency) {
  if (amount === null || amount === undefined || !Number.isFinite(Number(amount))) return '';
  const n = Number(amount);
  const v = Number.isInteger(n) ? String(n) : n.toFixed(2);
  return SYMBOLS[currency] ? `${SYMBOLS[currency]}${v}` : `${v}${currency ? ' ' + currency : ''}`;
}

function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;
const normEmail = (e) => String(e ?? '').trim().toLowerCase();
const normSku = (s) => String(s ?? '').trim().toUpperCase();
const validEmail = (e) => e.length <= 254 && EMAIL_RE.test(e);
const validSku = (s) => /^[A-Z0-9][A-Z0-9._-]{0,63}$/.test(s);

function validUrl(u) {
  try {
    const x = new URL(String(u));
    return /^https?:$/.test(x.protocol) && String(u).length <= 2000 ? x.href : null;
  } catch { return null; }
}

module.exports = { esc, now, money, safeEqual, normEmail, normSku, validEmail, validSku, validUrl };
