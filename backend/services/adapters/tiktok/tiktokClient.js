// Low-level HTTP client for TikTok's official API (open.tiktokapis.com).
// Every call goes through here so timeout/retry/rate-limit/structured-error
// handling is consistent, matching the same pattern used for 9Router in
// router.service.js. This file NEVER talks to any non-official TikTok
// endpoint - no scraping, no private/unofficial API, no login automation.
//
// IMPORTANT: exact request/response shapes reflect TikTok's publicly
// documented v2 API as of this integration's writing. TikTok's API
// evolves - verify against https://developers.tiktok.com/doc/ before
// relying on this in production, and this has NOT been tested against a
// live TikTok Developer app (no network access during development).
require('dotenv').config();
const logger = require('../../../utils/logger');

const TIKTOK_API_BASE = 'https://open.tiktokapis.com';
const TIMEOUT_MS = parseInt(process.env.TIKTOK_API_TIMEOUT_MS || '20000', 10);
const MAX_RETRIES = 2;

function isAppConfigured() {
  return !!(process.env.TIKTOK_CLIENT_KEY && process.env.TIKTOK_CLIENT_SECRET);
}

function looksLikeRateLimit(status, body) {
  if (status === 429) return true;
  const code = body?.error?.code || body?.data?.error_code;
  return code === 'rate_limit_exceeded' || code === 'too_many_requests';
}

function looksLikeTokenExpired(status, body) {
  const code = body?.error?.code;
  return status === 401 || code === 'access_token_invalid' || code === 'access_token_expired';
}

/**
 * Generic authenticated call to a TikTok API endpoint.
 * @param {string} path - e.g. '/v2/user/info/'
 * @param {object} options - { method, accessToken, body, query, isFormEncoded }
 * @returns {Promise<{ok:boolean, status:number, data:object, tokenExpired?:boolean, rateLimited?:boolean, error?:string}>}
 */
async function callTikTokApi(path, options = {}) {
  if (!isAppConfigured()) {
    const err = new Error('NOT_CONFIGURED: TIKTOK_CLIENT_KEY/TIKTOK_CLIENT_SECRET belum diset di .env');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }

  const { method = 'GET', accessToken, body, query, isFormEncoded = false } = options;

  let url = `${TIKTOK_API_BASE}${path}`;
  if (query) {
    const qs = new URLSearchParams(query).toString();
    url += `?${qs}`;
  }

  const headers = { Accept: 'application/json' };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  if (body && isFormEncoded) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  else if (body) headers['Content-Type'] = 'application/json';

  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

      const res = await fetch(url, {
        method,
        headers,
        body: body ? (isFormEncoded ? new URLSearchParams(body).toString() : JSON.stringify(body)) : undefined,
        signal: controller.signal,
      });
      clearTimeout(timer);

      let data = {};
      try { data = await res.json(); } catch (_) { /* non-JSON response, keep data = {} */ }

      if (looksLikeRateLimit(res.status, data)) {
        logger.log('tiktok', 'warn', `Rate limited on ${path} (attempt ${attempt + 1}/${MAX_RETRIES + 1})`);
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1) * 2));
        continue; // retry
      }

      return {
        ok: res.ok,
        status: res.status,
        data,
        tokenExpired: looksLikeTokenExpired(res.status, data),
        rateLimited: false,
        error: !res.ok ? (data?.error?.message || data?.message || `HTTP ${res.status}`) : undefined,
      };
    } catch (err) {
      lastError = err;
      logger.log('tiktok', 'warn', `Call to ${path} failed (attempt ${attempt + 1}/${MAX_RETRIES + 1})`, { error: err.message });
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }

  logger.log('tiktok', 'error', `All retries exhausted for ${path}`, { error: lastError?.message });
  return { ok: false, status: 0, data: {}, error: `Network/timeout error after retries: ${lastError?.message}` };
}

module.exports = { callTikTokApi, isAppConfigured, TIKTOK_API_BASE };
