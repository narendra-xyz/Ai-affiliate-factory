// TikTok Shop Creator authorization flow - separate from the general
// TikTok Login Kit OAuth (tiktok/tiktokAuth.adapter.js). TikTok Shop
// Partner Center apps use their own authorization page and token
// exchange endpoint.
//
// Reference: https://partner.tiktokshop.com/docv2 (Authorization section)
// Not tested against a live TikTok Shop Partner app (no network access
// during development) - verify against current docs before production.
require('dotenv').config();
const { callShopApi, isAppConfigured } = require('./tiktokShopClient');

const AUTHORIZE_BASE = process.env.TIKTOK_SHOP_AUTHORIZE_URL || 'https://services.tiktokshop.com/open/authorize';

function buildAuthorizeUrl(state) {
  if (!isAppConfigured()) {
    const err = new Error('NOT_CONFIGURED: TIKTOK_SHOP_APP_KEY/TIKTOK_SHOP_APP_SECRET belum diset');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }
  const redirectUri = process.env.TIKTOK_SHOP_REDIRECT_URI;
  if (!redirectUri) {
    const err = new Error('NOT_CONFIGURED: TIKTOK_SHOP_REDIRECT_URI belum diset di .env');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }

  const params = new URLSearchParams({
    service_id: process.env.TIKTOK_SHOP_SERVICE_ID || process.env.TIKTOK_SHOP_APP_KEY,
    redirect_uri: redirectUri,
    state,
  });
  return `${AUTHORIZE_BASE}?${params.toString()}`;
}

/**
 * @returns {Promise<{ok:boolean, accessToken?, refreshToken?, expiresIn?, refreshExpiresIn?, shopCreatorId?, shopId?, shopName?, scope?, error?}>}
 */
async function exchangeCodeForToken(authCode) {
  const res = await callShopApi('/authorization/202309/token/get', {
    method: 'GET',
    query: { auth_code: authCode, grant_type: 'authorized_code' },
  });

  if (!res.ok) return { ok: false, error: res.error || 'TikTok Shop token exchange failed' };

  const d = res.data?.data || {};
  return {
    ok: true,
    accessToken: d.access_token,
    refreshToken: d.refresh_token,
    expiresIn: d.access_token_expire_in,
    refreshExpiresIn: d.refresh_token_expire_in,
    shopCreatorId: d.open_id || d.seller_id,
    shopId: d.seller_name ? undefined : (d.shop_id || undefined),
    shopName: d.seller_name,
    scope: (d.granted_scopes || []).join(' '),
  };
}

/**
 * @returns {Promise<{ok:boolean, accessToken?, refreshToken?, expiresIn?, refreshExpiresIn?, error?}>}
 */
async function refreshAccessToken(refreshToken) {
  const res = await callShopApi('/authorization/202309/token/refresh', {
    method: 'GET',
    query: { refresh_token: refreshToken, grant_type: 'refresh_token' },
  });

  if (!res.ok) return { ok: false, error: res.error || 'TikTok Shop token refresh failed', tokenExpired: res.tokenExpired };

  const d = res.data?.data || {};
  return {
    ok: true,
    accessToken: d.access_token,
    refreshToken: d.refresh_token || refreshToken,
    expiresIn: d.access_token_expire_in,
    refreshExpiresIn: d.refresh_token_expire_in,
  };
}

module.exports = { buildAuthorizeUrl, exchangeCodeForToken, refreshAccessToken };
