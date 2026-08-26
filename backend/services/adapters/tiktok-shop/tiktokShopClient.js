// Low-level HTTP client for TikTok Shop Partner Center's official API.
// This is a SEPARATE API surface from the general TikTok Content Posting
// API (backend/services/adapters/tiktok/) - different base domain,
// different app credentials (app_key/app_secret registered in TikTok
// Shop Partner Center, not the regular TikTok Developer portal), and
// TikTok Shop's API requires REQUEST SIGNING (HMAC-SHA256) on every
// call, unlike the plain Bearer-token auth used by the Content Posting
// API. This client never talks to any non-official endpoint - no
// scraping, no private API, no browser automation.
//
// IMPORTANT: the exact signing algorithm and endpoint paths reflect
// TikTok Shop Partner Center's publicly documented conventions as of
// this integration's writing. Verify against
// https://partner.tiktokshop.com/docv2 before production use - this has
// NOT been tested against a live TikTok Shop Partner app (no network
// access during development).
require('dotenv').config();
const crypto = require('crypto');
const logger = require('../../../utils/logger');

const SHOP_API_BASE = process.env.TIKTOK_SHOP_API_BASE || 'https://open-api.tiktokglobalshop.com';
const TIMEOUT_MS = parseInt(process.env.TIKTOK_SHOP_API_TIMEOUT_MS || '20000', 10);
const MAX_RETRIES = 2;

function isAppConfigured() {
  return !!(process.env.TIKTOK_SHOP_APP_KEY && process.env.TIKTOK_SHOP_APP_SECRET);
}

/**
 * TikTok Shop Partner API request signing: params (including app_key,
 * timestamp, access_token if applicable, but excluding `sign` itself)
 * are sorted alphabetically by key, concatenated as key+value pairs, the
 * request path is prepended, and the app_secret wraps both ends before
 * HMAC-SHA256 signing. This mirrors TikTok Shop's documented signing
 * scheme - re-verify the exact byte-for-byte construction against
 * current docs, as Shop API signing has had versioned variations.
 */
function signRequest(path, params, body) {
  const secret = process.env.TIKTOK_SHOP_APP_SECRET;
  const sortedKeys = Object.keys(params).filter((k) => k !== 'sign').sort();
  let base = path;
  for (const key of sortedKeys) base += `${key}${params[key]}`;
  if (body) base += JSON.stringify(body);
  base = `${secret}${base}${secret}`;
  return crypto.createHmac('sha256', secret).update(base).digest('hex');
}

function looksLikeRateLimit(status, data) {
  if (status === 429) return true;
  const code = data?.code;
  return code === 429000 || code === 105002; // documented Shop API rate-limit style codes
}

function looksLikeTokenExpired(status, data) {
  const code = data?.code;
  return status === 401 || code === 105003 || code === 106001; // documented Shop API auth-error style codes
}

/**
 * @param {string} path - e.g. '/product/202309/products/search'
 * @param {object} options - { method, accessToken, body, query }
 */
async function callShopApi(path, options = {}) {
  if (!isAppConfigured()) {
    const err = new Error('NOT_CONFIGURED: TIKTOK_SHOP_APP_KEY/TIKTOK_SHOP_APP_SECRET belum diset di .env');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }

  const { method = 'GET', accessToken, body, query = {} } = options;
  const timestamp = Math.floor(Date.now() / 1000);

  const params = {
    app_key: process.env.TIKTOK_SHOP_APP_KEY,
    timestamp,
    ...query,
  };
  if (process.env.TIKTOK_SHOP_SERVICE_ID) params.shop_cipher = process.env.TIKTOK_SHOP_SHOP_CIPHER || undefined;

  const sign = signRequest(path, params, body);
  const qs = new URLSearchParams({ ...params, sign }).toString();
  const url = `${SHOP_API_BASE}${path}?${qs}`;

  const headers = { 'Content-Type': 'application/json' };
  if (accessToken) headers['x-tts-access-token'] = accessToken;

  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

      const res = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      clearTimeout(timer);

      let data = {};
      try { data = await res.json(); } catch (_) { /* non-JSON response */ }

      if (looksLikeRateLimit(res.status, data)) {
        logger.log('tiktok_shop', 'warn', `Rate limited on ${path} (attempt ${attempt + 1}/${MAX_RETRIES + 1})`);
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1) * 2));
        continue;
      }

      const ok = res.ok && (data.code === undefined || data.code === 0);
      return {
        ok,
        status: res.status,
        data,
        tokenExpired: looksLikeTokenExpired(res.status, data),
        error: !ok ? (data?.message || `HTTP ${res.status}`) : undefined,
      };
    } catch (err) {
      lastError = err;
      logger.log('tiktok_shop', 'warn', `Call to ${path} failed (attempt ${attempt + 1}/${MAX_RETRIES + 1})`, { error: err.message });
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }

  logger.log('tiktok_shop', 'error', `All retries exhausted for ${path}`, { error: lastError?.message });
  return { ok: false, status: 0, data: {}, error: `Network/timeout error after retries: ${lastError?.message}` };
}

module.exports = { callShopApi, isAppConfigured, signRequest, SHOP_API_BASE };
