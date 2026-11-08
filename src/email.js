'use strict';
// The back-in-stock email (table layout + inline styles so it renders in real mail clients)
// and the Resend-format sender.
const crypto = require('node:crypto');
const config = require('./config');
const { esc, money } = require('./util');

function renderEmail(r) {
  const name = r.product_name || r.sku;
  const price = money(r.product_price, r.product_currency);
  const url = r.page_url || config.storeUrl || '';
  const brand = esc(config.brandName);
  const subject = `It's back: ${name}`;
  const preheader = `Good news: ${name} is back in stock. Popular items go fast.`;

  const button = url
    ? `<tr><td style="padding:8px 32px 8px 32px;">
         <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
           <td align="center" bgcolor="#14532d" style="border-radius:10px;">
             <a href="${esc(url)}" target="_blank" style="display:block;padding:15px 24px;font-family:Helvetica,Arial,sans-serif;font-size:16px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:10px;">Shop it now &rarr;</a>
           </td></tr></table>
       </td></tr>`
    : `<tr><td style="padding:4px 32px 8px 32px;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:22px;color:#3f4a44;">
         Head back to the store and search for <strong>${esc(r.sku)}</strong> to grab it.
       </td></tr>`;

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only"><title>${esc(subject)}</title>
<style>
  @media only screen and (max-width:620px){ .container{width:100%!important} .px{padding-left:20px!important;padding-right:20px!important} .h1{font-size:24px!important;line-height:30px!important} }
</style></head>
<body style="margin:0;padding:0;background:#f3f1ec;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f3f1ec">
<tr><td align="center" style="padding:28px 12px;">
  <table role="presentation" class="container" width="560" cellpadding="0" cellspacing="0" border="0" style="width:560px;max-width:560px;">
    <tr><td class="px" style="padding:0 32px 16px 32px;font-family:Helvetica,Arial,sans-serif;font-size:15px;font-weight:700;letter-spacing:.3px;color:#14532d;">&#9679; ${brand}</td></tr>
    <tr><td bgcolor="#ffffff" style="background:#ffffff;border-radius:16px;overflow:hidden;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr><td class="px" style="padding:32px 32px 6px 32px;font-family:Helvetica,Arial,sans-serif;font-size:13px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:#15803d;">Back in stock</td></tr>
        <tr><td class="px h1" style="padding:0 32px 12px 32px;font-family:Georgia,'Times New Roman',serif;font-size:28px;line-height:34px;color:#16211b;">The wait is over.</td></tr>
        <tr><td class="px" style="padding:0 32px 24px 32px;font-family:Helvetica,Arial,sans-serif;font-size:16px;line-height:24px;color:#3f4a44;">
          You asked us to let you know when this came back. It just did, and restocks like this tend to sell through quickly.
        </td></tr>
        ${r.product_image ? `<tr><td class="px" style="padding:0 32px 0 32px;"><img src="${esc(r.product_image)}" width="496" alt="${esc(name)}" style="display:block;width:100%;max-width:496px;height:auto;border-radius:12px;border:0;"></td></tr>` : ''}
        <tr><td class="px" style="padding:20px 32px 4px 32px;font-family:Helvetica,Arial,sans-serif;font-size:19px;line-height:26px;font-weight:700;color:#16211b;">${esc(name)}</td></tr>
        <tr><td class="px" style="padding:0 32px 20px 32px;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:22px;color:#5b665f;">
          ${price ? `<strong style="color:#16211b;">${esc(price)}</strong> &nbsp;&middot;&nbsp; ` : ''}SKU ${esc(r.sku)}
        </td></tr>
        ${button}
        <tr><td class="px" style="padding:20px 32px 32px 32px;font-family:Helvetica,Arial,sans-serif;font-size:13px;line-height:20px;color:#7a847e;">
          This is a one-time alert. We won't email you about this item again unless you sign up for another alert.
        </td></tr>
      </table>
    </td></tr>
    <tr><td class="px" style="padding:18px 32px 0 32px;font-family:Helvetica,Arial,sans-serif;font-size:12px;line-height:18px;color:#8b938e;text-align:center;">
      You're receiving this because ${esc(r.email)} asked for a back-in-stock alert.<br>Sent by ${brand}.
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;

  const text = [
    `Back in stock: ${name}`,
    '',
    'You asked us to let you know when this came back. It just did.',
    price ? `${name} · ${price} · SKU ${r.sku}` : `${name} · SKU ${r.sku}`,
    url ? `\nShop it now: ${url}` : `\nHead back to the store and search for ${r.sku}.`,
    '',
    "This is a one-time alert. We won't email you about this item again.",
  ].join('\n');

  return { subject, html, text };
}

// Builds the exact request for one alert: the Idempotency-Key and the JSON body string.
// The caller stores both before the first network call and reuses them byte-for-byte on
// every retry and after restarts, so one key is only ever paired with one payload.
// The key includes a random part: request ids restart at 1 in a fresh database (e.g. a new
// deploy), and the provider remembers keys, so `restock-alert-<id>` alone could collide with
// an email sent earlier and be silently dropped as a duplicate.
function buildOutbound(r) {
  const { subject, html, text } = renderEmail(r);
  return {
    key: `restock-alert-${r.id}-${crypto.randomUUID()}`,
    body: JSON.stringify({ from: config.emailFrom, to: [r.email], subject, html, text }),
  };
}

// Sends a previously frozen request ({ key, body }) in the Resend API format.
async function sendFrozen({ key, body: payload }) {
  let res;
  try {
    res = await fetch(`${config.resendBaseUrl}/emails`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.resendApiKey}`,
        'content-type': 'application/json',
        'idempotency-key': key,
      },
      body: payload,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    return { ok: false, error: `network: ${e.message || e}` };
  }
  let body = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  if (res.ok) return { ok: true, id: body && body.id ? String(body.id) : null };
  return { ok: false, status: res.status, error: `HTTP ${res.status}${body && body.message ? `: ${body.message}` : ''}` };
}

module.exports = { renderEmail, buildOutbound, sendFrozen };
