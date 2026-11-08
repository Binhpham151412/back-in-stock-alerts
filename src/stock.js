'use strict';
// Client for the stock API. This is the source of truth: webhook quantities are only hints.
const config = require('./config');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, { timeoutMs = 5000, tries = 2 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, {
        headers: { authorization: `Bearer ${config.stockApiKey}`, accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (r.status >= 500) throw new Error(`stock API HTTP ${r.status}`);
      if (!r.ok) {
        const err = new Error(`stock API HTTP ${r.status}`);
        err.permanent = true;
        throw err;
      }
      return await r.json();
    } catch (e) {
      lastErr = e;
      if (e.permanent) break;
      if (i < tries - 1) await sleep(300 * (i + 1));
    }
  }
  throw lastErr;
}

// Returns { sku, name, price, currency, image, quantity, inStock }. Throws if we can't tell.
async function checkStock(sku) {
  if (!config.stockApiUrl) throw new Error('STOCK_API_URL is not set');
  const data = await getJson(`${config.stockApiUrl}/${encodeURIComponent(sku)}`);
  const quantity = Number(data && data.quantity);
  if (!Number.isFinite(quantity)) throw new Error('stock API returned no quantity');
  const product = {
    sku,
    name: typeof data.name === 'string' ? data.name : null,
    price: Number.isFinite(Number(data.price)) && data.price !== undefined ? Number(data.price) : null,
    currency: typeof data.currency === 'string' ? data.currency : null,
    image: typeof data.image === 'string' && /^https?:\/\//.test(data.image) ? data.image : null,
    quantity,
    inStock: quantity > 0 && data.in_stock !== false,
  };
  cacheProduct(product);
  return product;
}

// Small in-memory cache of product details for the embed preview and the admin page.
const products = new Map();
function cacheProduct(p) {
  if (p.name) products.set(p.sku, { ...p, cachedAt: Date.now() });
}
const cachedProduct = (sku) => products.get(sku) || null;

let catalogue = { at: 0, items: [] };
async function getCatalogue() {
  if (Date.now() - catalogue.at < 60_000) return catalogue.items;
  try {
    const data = await getJson(config.stockApiUrl, { timeoutMs: 4000, tries: 1 });
    const items = (Array.isArray(data) ? data : data.products || [])
      .filter((p) => p && typeof p.sku === 'string')
      .map((p) => ({
        sku: p.sku, name: p.name || p.sku, price: p.price ?? null, currency: p.currency || null,
        image: p.image || null, quantity: Number(p.quantity) || 0, inStock: Number(p.quantity) > 0 && p.in_stock !== false,
      }));
    items.forEach(cacheProduct);
    catalogue = { at: Date.now(), items };
  } catch (e) {
    console.warn('[stock] catalogue fetch failed:', e.message);
  }
  return catalogue.items;
}

module.exports = { checkStock, cachedProduct, getCatalogue };
