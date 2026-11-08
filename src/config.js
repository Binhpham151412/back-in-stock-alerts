'use strict';
const path = require('node:path');

const trimSlash = (s) => String(s || '').trim().replace(/\/+$/, '');

module.exports = {
  port: Number(process.env.PORT || 3000),
  dataDir: process.env.DATA_DIR || path.join(__dirname, '..', 'data'),
  stockApiUrl: trimSlash(process.env.STOCK_API_URL),
  stockApiKey: process.env.STOCK_API_KEY || '',
  resendApiKey: process.env.RESEND_API_KEY || '',
  resendBaseUrl: trimSlash(process.env.RESEND_BASE_URL || 'https://api.resend.com'),
  webhookSecret: process.env.WEBHOOK_SECRET || '',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  // Optional extras with safe defaults.
  emailFrom: process.env.EMAIL_FROM || 'Restock Alerts <alerts@restock.example.com>',
  brandName: process.env.BRAND_NAME || 'Restock',
  storeUrl: process.env.STORE_URL || '', // fallback link in the email when the sign-up page URL is unknown
  reconcileSeconds: Number(process.env.RECONCILE_SECONDS || 300),
  maxEmailAttempts: Number(process.env.MAX_EMAIL_ATTEMPTS || 10),
};
