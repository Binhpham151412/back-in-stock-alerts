'use strict';
const config = require('./config');
const { esc, money } = require('./util');

const BASE_CSS = `
:root{--bg:#f6f5f1;--card:#fff;--ink:#16211b;--muted:#5d6862;--line:#e4e2db;--brand:#14532d;--brand-2:#15803d;--soft:#ecf5ee;--warn:#9a5b00;--warn-soft:#fff4df;--bad:#b42318;--bad-soft:#fdecea;--blue:#1d4ed8;--blue-soft:#e8efff;--radius:14px}
*{box-sizing:border-box}html,body{margin:0}
body{font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;color:var(--ink);background:var(--bg);-webkit-font-smoothing:antialiased}
a{color:var(--brand)}
input,button,select{font:inherit}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;border:0;border-radius:10px;background:var(--brand);color:#fff;font-weight:650;padding:12px 18px;cursor:pointer;transition:background .15s,transform .05s}
.btn:hover{background:#0f3f22}.btn:active{transform:translateY(1px)}.btn[disabled]{opacity:.6;cursor:progress}
.input{width:100%;border:1px solid var(--line);border-radius:10px;padding:12px 14px;background:#fff;color:var(--ink);outline:none;transition:border-color .15s,box-shadow .15s}
.input:focus{border-color:var(--brand-2);box-shadow:0 0 0 3px rgba(21,128,61,.15)}
.label{display:block;font-size:13px;font-weight:600;color:var(--muted);margin:0 0 6px}
.pill{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:3px 10px;font-size:12px;font-weight:650;white-space:nowrap}
.pill::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.p-waiting{background:var(--warn-soft);color:var(--warn)}.p-queued,.p-sending{background:var(--blue-soft);color:var(--blue)}
.p-notified,.p-confirmed{background:var(--soft);color:var(--brand-2)}.p-failed,.p-phantom{background:var(--bad-soft);color:var(--bad)}
.p-sellout,.p-unverified,.p-processing{background:#f0efea;color:var(--muted)}
.muted{color:var(--muted)}
`;

function doc(title, body, { css = '', head = '' } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>${head}<style>${BASE_CSS}${css}</style></head><body>${body}</body></html>`;
}

// ---------------- embeddable form ----------------
function embedPage({ sku }) {
  const css = `
body{background:transparent;padding:4px}
.card{max-width:440px;margin:0 auto;background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:22px;box-shadow:0 1px 2px rgba(16,24,20,.04),0 8px 24px rgba(16,24,20,.06)}
.eyebrow{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--brand-2);margin-bottom:6px}
h1{font-size:20px;line-height:1.25;margin:0 0 6px;letter-spacing:-.01em}
.sub{margin:0 0 18px;color:var(--muted);font-size:14px}
.product{display:none;gap:12px;align-items:center;padding:10px;border:1px solid var(--line);border-radius:12px;margin-bottom:16px;background:#fbfaf7}
.product.show{display:flex}.product img{width:56px;height:56px;border-radius:9px;object-fit:cover;background:#eee;flex:none}
.product .n{font-weight:650;font-size:14px;line-height:1.3}.product .m{font-size:13px;color:var(--muted)}
.field{margin-bottom:12px}
.btn{width:100%;margin-top:4px;padding:13px 18px}
.err{display:none;color:var(--bad);font-size:13px;margin:8px 0 0}.err.show{display:block}
.fine{font-size:12px;color:var(--muted);margin:12px 0 0;text-align:center}
.done{display:none;text-align:center;padding:8px 4px}
.done .icon{width:52px;height:52px;border-radius:50%;margin:4px auto 12px;display:grid;place-items:center;background:var(--soft);color:var(--brand-2)}
.done h2{font-size:19px;margin:0 0 6px}.done p{margin:0 auto;color:var(--muted);font-size:14px;max-width:320px}
.link{background:none;border:0;color:var(--brand);font-weight:600;cursor:pointer;margin-top:14px;padding:4px}
.card.is-done form,.card.is-done .head{display:none}.card.is-done .done{display:block}
@media (max-width:380px){.card{padding:18px}}
`;
  const body = `<div class="card" id="card">
  <div class="head">
    <div class="eyebrow"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>Back-in-stock alert</div>
    <h1 id="title">Sold out, for now.</h1>
    <p class="sub" id="sub">Leave your email and we'll send you one message the moment it's back. No spam, no newsletter.</p>
    <div class="product" id="product"><img id="pimg" alt=""><div><div class="n" id="pname"></div><div class="m" id="pmeta"></div></div></div>
  </div>
  <form id="form" novalidate>
    <div class="field" id="skuField"${sku ? ' hidden' : ''}>
      <label class="label" for="sku">Product SKU</label>
      <input class="input" id="sku" name="sku" list="skus" autocomplete="off" spellcheck="false" placeholder="e.g. TEE-ORG-BLK-L" value="${esc(sku)}" maxlength="64" required>
      <datalist id="skus"></datalist>
    </div>
    <div class="field">
      <label class="label" for="email">Email address</label>
      <input class="input" id="email" name="email" type="email" inputmode="email" autocomplete="email" placeholder="you@example.com" maxlength="254" required>
    </div>
    <button class="btn" id="submit" type="submit">Notify me when it's back</button>
    <p class="err" id="err" role="alert"></p>
    <p class="fine">One email, once. We only use your address for this alert.</p>
  </form>
  <div class="done" id="done" aria-live="polite">
    <div class="icon"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg></div>
    <h2 id="doneTitle">You're on the list</h2>
    <p id="doneText"></p>
    <button class="link" id="again" type="button">Get an alert for another item</button>
  </div>
</div>
<script>
(() => {
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const fixedSku = ${JSON.stringify(sku || '')};
  const pageUrl = params.get('page') || (document.referrer && !document.referrer.startsWith(location.origin) ? document.referrer : '');
  const money = (p, c) => p == null ? '' : ({GBP:'£',USD:'$',EUR:'€'}[c] || '') + (Number.isInteger(p) ? p : Number(p).toFixed(2)) + ({GBP:1,USD:1,EUR:1}[c] ? '' : (c ? ' ' + c : ''));
  const resize = () => parent !== window && parent.postMessage({ type: 'restock:resize', height: document.documentElement.scrollHeight }, '*');
  new ResizeObserver(resize).observe(document.body);

  let lastSku = '';
  async function preview(sku) {
    sku = sku.trim().toUpperCase();
    if (!sku || sku === lastSku) return; lastSku = sku;
    try {
      const r = await fetch('/api/products/' + encodeURIComponent(sku));
      if (!r.ok || sku !== lastSku) return;
      const p = await r.json();
      if (!p.name) { $('product').classList.remove('show'); return; }
      $('pimg').src = p.image || ''; $('pimg').alt = p.name;
      $('pname').textContent = p.name;
      $('pmeta').textContent = [money(p.price, p.currency), p.in_stock ? 'In stock right now' : 'Sold out'].filter(Boolean).join(' · ');
      $('title').textContent = p.in_stock ? 'Good news: it\\'s in stock.' : 'Sold out, for now.';
      $('sub').textContent = p.in_stock
        ? 'It\\'s available right now. Leave your email and we\\'ll send you the details, just once.'
        : 'Leave your email and we\\'ll send you one message the moment it\\'s back. No spam, no newsletter.';
      $('product').classList.add('show');
    } catch {}
  }
  if (fixedSku) preview(fixedSku);
  else {
    fetch('/api/products').then((r) => r.ok ? r.json() : { products: [] }).then((d) => {
      $('skus').innerHTML = (d.products || []).map((p) => '<option value="' + p.sku + '">' + p.name.replace(/[<>&"]/g, '') + (p.in_stock ? '' : ' (sold out)') + '</option>').join('');
    }).catch(() => {});
    let t; $('sku').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => preview(e.target.value), 350); });
  }

  const showErr = (m) => { $('err').textContent = m; $('err').classList.toggle('show', !!m); resize(); };
  $('form').addEventListener('submit', async (e) => {
    e.preventDefault(); showErr('');
    const email = $('email').value.trim(), sku = (fixedSku || $('sku').value).trim();
    if (!sku) return showErr('Please enter the product SKU.');
    if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]{2,}$/.test(email)) return showErr('Please enter a valid email address.');
    $('submit').disabled = true; $('submit').textContent = 'Saving…';
    try {
      const r = await fetch('/api/requests', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, sku, page_url: pageUrl || undefined }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Something went wrong. Please try again.');
      const name = (d.request && d.request.product && d.request.product.name) || sku.toUpperCase();
      const copy = {
        waiting: ["You're on the list", 'We\\'ll email ' + email + ' as soon as ' + name + ' is back. Just once, and only for this item.'],
        already_waiting: ["You're already on the list", email + ' is already waiting for ' + name + '. We\\'ll send one email when it\\'s back.'],
        in_stock: ['Good news: it\\'s in stock', name + ' is available right now. We\\'ve sent the details to ' + email + '.'],
      }[d.result] || ["You're on the list", ''];
      $('doneTitle').textContent = copy[0]; $('doneText').textContent = copy[1];
      $('card').classList.add('is-done');
    } catch (err) { showErr(err.message || 'Network error. Please try again.'); }
    finally { $('submit').disabled = false; $('submit').textContent = 'Notify me when it\\'s back'; resize(); }
  });
  $('again').addEventListener('click', () => { $('card').classList.remove('is-done'); $('email').value = ''; if (!fixedSku) { $('sku').value = ''; lastSku = ''; $('product').classList.remove('show'); } $('email').focus(); });
})();
</script>`;
  return doc('Back-in-stock alert', body, { css });
}

// ---------------- demo store page ----------------
function homePage({ product }) {
  const p = product || {};
  const sku = p.sku || 'TEE-ORG-BLK-L';
  const css = `
.top{background:#fff;border-bottom:1px solid var(--line)}.top .in{max-width:1040px;margin:0 auto;padding:16px 20px;display:flex;justify-content:space-between;align-items:center}
.logo{font-weight:800;letter-spacing:-.02em;font-size:18px;color:var(--brand)}
.wrap{max-width:1040px;margin:0 auto;padding:32px 20px 64px;display:grid;grid-template-columns:1.1fr 1fr;gap:40px}
.img{width:100%;aspect-ratio:1;border-radius:18px;object-fit:cover;background:#e9e7e0}
.crumbs{font-size:13px;color:var(--muted)}h1{font-size:32px;line-height:1.15;letter-spacing:-.02em;margin:6px 0 8px}
.price{font-size:22px;font-weight:700;margin-bottom:14px}.note{margin-top:28px;font-size:13px;color:var(--muted);border-top:1px solid var(--line);padding-top:16px}
iframe{width:100%;border:0;height:430px;display:block}
@media (max-width:820px){.wrap{grid-template-columns:1fr;gap:20px}h1{font-size:26px}}
`;
  const body = `<div class="top"><div class="in"><div class="logo">● ${esc(config.brandName)} <span class="muted" style="font-weight:500">demo store</span></div><a href="/admin">Admin</a></div></div>
<div class="wrap">
  <div>${p.image ? `<img class="img" src="${esc(p.image)}" alt="${esc(p.name || sku)}">` : '<div class="img"></div>'}</div>
  <div>
    <div class="crumbs">Shop / ${esc(sku)}</div>
    <h1>${esc(p.name || sku)}</h1>
    <div class="price">${esc(money(p.price, p.currency))} ${p.inStock === false ? '<span class="pill p-failed" style="vertical-align:middle;margin-left:6px">Sold out</span>' : p.inStock ? '<span class="pill p-notified" style="vertical-align:middle;margin-left:6px">In stock</span>' : ''}</div>
    <iframe id="restock" src="/embed?sku=${encodeURIComponent(sku)}" title="Back-in-stock alert"></iframe>
    <p class="note">This is a stand-in product page. The form on the right is <code>/embed</code>, loaded in an iframe exactly as it would be on a real store. Try another product: <a href="/?sku=BAG-LTH-TAN">/?sku=BAG-LTH-TAN</a>, or the open form at <a href="/embed">/embed</a>.</p>
  </div>
</div>
<script>addEventListener('message',(e)=>{if(e.data&&e.data.type==='restock:resize'){document.getElementById('restock').style.height=(e.data.height+8)+'px'}})</script>`;
  return doc(`${p.name || sku} · ${config.brandName}`, body, { css });
}

// ---------------- admin ----------------
const ADMIN_CSS = `
.top{background:var(--brand);color:#fff}.top .in{max-width:1200px;margin:0 auto;padding:14px 20px;display:flex;justify-content:space-between;align-items:center;gap:12px}
.top .logo{font-weight:800;letter-spacing:-.01em}.top a,.top button{color:#d7f0de;background:none;border:0;font:inherit;cursor:pointer;text-decoration:none}
main{max-width:1200px;margin:0 auto;padding:24px 20px 64px}
h1{font-size:24px;letter-spacing:-.01em;margin:0}h2{font-size:16px;margin:32px 0 12px}
.head{display:flex;justify-content:space-between;align-items:flex-end;gap:12px;flex-wrap:wrap;margin-bottom:18px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:20px}
.stat{background:#fff;border:1px solid var(--line);border-radius:12px;padding:14px 16px;text-decoration:none;color:inherit}
.stat .v{font-size:26px;font-weight:750;letter-spacing:-.02em}.stat .k{font-size:13px;color:var(--muted)}
.stat.on{border-color:var(--brand-2);box-shadow:0 0 0 2px rgba(21,128,61,.15)}
.panel{background:#fff;border:1px solid var(--line);border-radius:12px;overflow:hidden}
.tools{display:flex;gap:10px;padding:12px;border-bottom:1px solid var(--line);flex-wrap:wrap;align-items:center}
.tools .input{max-width:320px;padding:9px 12px}.tools .btn{padding:9px 14px}
.scroll{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:14px}
th{text-align:left;font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);font-weight:650;padding:10px 14px;background:#fbfaf7;border-bottom:1px solid var(--line);white-space:nowrap}
td{padding:11px 14px;border-bottom:1px solid #f0eee8;vertical-align:middle}
tr:last-child td{border-bottom:0}
.prod{display:flex;gap:10px;align-items:center;min-width:220px}.prod img{width:36px;height:36px;border-radius:8px;object-fit:cover;background:#eee;flex:none}
.prod .n{font-weight:600;line-height:1.25}.sku{font:12px ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--muted)}
.when{white-space:nowrap}.when small{display:block;color:var(--muted);font-size:12px}
.err{color:var(--bad);font-size:12px;max-width:260px}
.empty{padding:28px;text-align:center;color:var(--muted)}
.live{font-size:12px;color:var(--muted);display:inline-flex;align-items:center;gap:6px}.live::before{content:"";width:7px;height:7px;border-radius:50%;background:#22c55e;box-shadow:0 0 0 3px rgba(34,197,94,.2)}
`;

function when(iso) {
  if (!iso) return '<span class="muted">—</span>';
  return `<time datetime="${esc(iso)}" title="${esc(iso)}">${esc(iso.replace('T', ' ').slice(0, 16))} UTC</time>`;
}

const LOCAL_TIME_JS = `<script>
(() => {
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const rel = (d) => { const s = (d - Date.now()) / 1000, a = Math.abs(s);
    return a < 60 ? rtf.format(Math.round(s), 'second') : a < 3600 ? rtf.format(Math.round(s / 60), 'minute') : a < 86400 ? rtf.format(Math.round(s / 3600), 'hour') : rtf.format(Math.round(s / 86400), 'day'); };
  document.querySelectorAll('time[datetime]').forEach((t) => { const d = new Date(t.dateTime);
    t.innerHTML = d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) + '<small>' + rel(d) + '</small>'; t.title = d.toString(); });
  // Live view: refresh while nobody is typing in the search box.
  setInterval(() => { if (document.activeElement && document.activeElement.tagName === 'INPUT') return; location.reload(); }, 15000);
})();
</script>`;

function adminLogin({ error } = {}) {
  const css = `body{display:grid;place-items:center;min-height:100vh;padding:20px}
.box{width:100%;max-width:380px;background:#fff;border:1px solid var(--line);border-radius:16px;padding:28px;box-shadow:0 8px 30px rgba(16,24,20,.07)}
.logo{font-weight:800;color:var(--brand);margin-bottom:18px}h1{font-size:22px;margin:0 0 4px}p{margin:0 0 20px;color:var(--muted);font-size:14px}
.btn{width:100%;margin-top:14px}.e{color:var(--bad);font-size:14px;margin:12px 0 0}`;
  return doc('Sign in · Admin', `<form class="box" method="post" action="/admin/login">
  <div class="logo">● ${esc(config.brandName)}</div>
  <h1>Admin sign in</h1><p>Back-in-stock requests and delivery status.</p>
  <label class="label" for="pw">Password</label>
  <input class="input" id="pw" name="password" type="password" autocomplete="current-password" autofocus required>
  <button class="btn">Sign in</button>
  ${error ? `<p class="e">${esc(error)}</p>` : ''}
</form>`, { css });
}

const STATUS_LABEL = { waiting: 'Waiting', queued: 'Queued', sending: 'Sending', notified: 'Notified', failed: 'Failed' };
const EVENT_LABEL = { confirmed: 'Restock confirmed', phantom: 'Not confirmed', sellout: 'Sold out', unverified: 'Unverified', processing: 'Processing' };

function adminPage({ stats, requests, total, events, filter, search }) {
  const statCard = (key, label, value) => `<a class="stat${filter === key ? ' on' : ''}" href="/admin?status=${key}${search ? `&q=${encodeURIComponent(search)}` : ''}"><div class="v">${value}</div><div class="k">${label}</div></a>`;
  const rows = requests.map((r) => `<tr>
    <td><div style="font-weight:600">${esc(r.email)}</div><div class="sku">#${r.id}</div></td>
    <td><div class="prod">${r.product_image ? `<img src="${esc(r.product_image)}" alt="" loading="lazy">` : '<img alt="">'}<div><div class="n">${esc(r.product_name || r.sku)}</div><div class="sku">${esc(r.sku)}</div></div></div></td>
    <td><span class="pill p-${esc(r.status)}">${esc(STATUS_LABEL[r.status] || r.status)}</span>${r.status === 'failed' || (r.last_error && r.status !== 'notified') ? `<div class="err">${esc(r.last_error || '')}</div>` : ''}</td>
    <td class="when">${when(r.created_at)}</td>
    <td class="when">${when(r.notified_at)}</td>
    <td>${r.attempts ? `${r.attempts}` : '<span class="muted">0</span>'}</td>
    <td class="muted" style="font-size:13px;max-width:220px">${esc(r.trigger || '')}</td>
  </tr>`).join('');
  const evRows = events.map((e) => `<tr>
    <td class="when">${when(e.received_at)}</td>
    <td><span class="sku">${esc(e.event_id)}</span></td>
    <td><span class="sku">${esc(e.sku)}</span></td>
    <td>${e.quantity ?? '—'}</td>
    <td>${e.verified_qty ?? '<span class="muted">—</span>'}</td>
    <td><span class="pill p-${esc(e.status)}">${esc(EVENT_LABEL[e.status] || e.status)}</span></td>
    <td>${e.deliveries > 1 ? `<strong>${e.deliveries}×</strong> <span class="muted">(deduped)</span>` : '1'}</td>
    <td>${e.queued || '<span class="muted">0</span>'}</td>
  </tr>`).join('');

  const body = `<div class="top"><div class="in"><div class="logo">● ${esc(config.brandName)} <span style="opacity:.7;font-weight:500">admin</span></div>
  <form method="post" action="/admin/logout" style="margin:0"><button>Sign out</button></form></div></div>
<main>
  <div class="head"><div><h1>Back-in-stock requests</h1><div class="muted">Every request, its status, and when the customer was emailed.</div></div><span class="live">Live · refreshes every 15s</span></div>
  <div class="stats">
    ${statCard('all', 'All requests', stats.all)}
    ${statCard('waiting', 'Waiting for restock', stats.waiting)}
    ${statCard('queued', 'Queued / sending', stats.queued + stats.sending)}
    ${statCard('notified', 'Notified', stats.notified)}
    ${statCard('failed', 'Failed', stats.failed)}
  </div>
  <div class="panel">
    <form class="tools" method="get" action="/admin">
      <input type="hidden" name="status" value="${esc(filter)}">
      <input class="input" type="search" name="q" value="${esc(search)}" placeholder="Search email or SKU">
      <button class="btn">Search</button>
      <span class="muted" style="margin-left:auto;font-size:13px">${total} result${total === 1 ? '' : 's'}${total > requests.length ? `, showing the latest ${requests.length}` : ''}</span>
    </form>
    <div class="scroll"><table>
      <tr><th>Customer</th><th>Product</th><th>Status</th><th>Requested</th><th>Notified</th><th>Sends</th><th>Trigger</th></tr>
      ${rows || '<tr><td colspan="7" class="empty">No requests yet. They\'ll appear here as customers sign up.</td></tr>'}
    </table></div>
  </div>

  <h2>Recent stock webhooks</h2>
  <div class="panel"><div class="scroll"><table>
    <tr><th>Received</th><th>Event</th><th>SKU</th><th>Claimed qty</th><th>Verified qty</th><th>Outcome</th><th>Deliveries</th><th>Alerts queued</th></tr>
    ${evRows || '<tr><td colspan="8" class="empty">No webhooks received yet.</td></tr>'}
  </table></div></div>
  <p class="muted" style="font-size:13px;margin-top:14px">Webhook quantities are treated as hints: every restock is checked against the stock API before anyone is emailed. Duplicate deliveries of the same event are acknowledged and ignored.</p>
</main>${LOCAL_TIME_JS}`;
  return doc('Admin · Back-in-stock', body, { css: ADMIN_CSS });
}

module.exports = { embedPage, homePage, adminLogin, adminPage };
