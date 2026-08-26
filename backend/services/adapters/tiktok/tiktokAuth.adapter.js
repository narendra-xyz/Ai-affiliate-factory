// TikTok OAuth 2.0 (Login Kit) - official flow only:
// 1. buildAuthorizeUrl() - browser redirects here, user approves on tiktok.com
// 2. exchangeCodeForToken() - server exchanges the returned `code` for tokens
// 3. refreshAccessToken() - uses refresh_token to get a new access_token
//    once the current one expires (TikTok access tokens are short-lived).
//
// Reference: https://developers.tiktok.com/doc/login-kit-web
// Endpoints below match TikTok's documented v2 OAuth contract - verify
// against current docs before production use; not tested live (no
// network access during development of this integration).
require('dotenv').config();
const { callTikTokApi, isAppConfigured } = require('./tiktokClient');

const AUTHORIZE_BASE = 'https://www.tiktok.com/v2/auth/authorize/';
const DEFAULT_SCOPES = process.env.TIKTOK_OAUTH_SCOPES || 'user.info.basic,video.publish,video.list';

function buildAuthorizeUrl(state) {
  if (!isAppConfigured()) {
    const err = new Error('NOT_CONFIGURED: TIKTOK_CLIENT_KEY/TIKTOK_CLIENT_SECRET belum diset');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }
  const redirectUri = process.env.TIKTOK_REDIRECT_URI;
  if (!redirectUri) {
    const err = new Error('NOT_CONFIGURED: TIKTOK_REDIRECT_URI belum diset di .env');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }

  const params = new URLSearchParams({
    client_key: process.env.TIKTOK_CLIENT_KEY,
    scope: DEFAULT_SCOPES.replace(/,/g, ','),
    response_type: 'code',
    redirect_uri: redirectUri,
    state,
  });
  return `${AUTHORIZE_BASE}?${params.toString()}`;
}

/**
 * @returns {Promise<{ok:boolean, accessToken?, refreshToken?, expiresIn?, refreshExpiresIn?, openId?, scope?, error?}>}
 */
async function exchangeCodeForToken(code) {
  const redirectUri = process.env.TIKTOK_REDIRECT_URI;
  const res = await callTikTokApi('/v2/oauth/token/', {
    method: 'POST',
    isFormEncoded: true,
    body: {
      client_key: process.env.TIKTOK_CLIENT_KEY,
      client_secret: process.env.TIKTOK_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    },
  });

  if (!res.ok) return { ok: false, error: res.error || 'Token exchange failed' };

  const d = res.data;
  return {
    ok: true,
    accessToken: d.access_token,
    refreshToken: d.refresh_token,
    expiresIn: d.expires_in,           // seconds
    refreshExpiresIn: d.refresh_expires_in, // seconds
    openId: d.open_id,
    scope: d.scope,
  };
}

/**
 * @returns {Promise<{ok:boolean, accessToken?, refreshToken?, expiresIn?, refreshExpiresIn?, error?}>}
 */
async function refreshAccessToken(refreshToken) {
  const res = await callTikTokApi('/v2/oauth/token/', {
    method: 'POST',
    isFormEncoded: true,
    body: {
      client_key: process.env.TIKTOK_CLIENT_KEY,
      client_secret: process.env.TIKTOK_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    },
  });

  if (!res.ok) return { ok: false, error: res.error || 'Token refresh failed', tokenExpired: res.tokenExpired };

  const d = res.data;
  return {
    ok: true,
    accessToken: d.access_token,
    refreshToken: d.refresh_token || refreshToken, // TikTok may rotate refresh tokens
    expiresIn: d.expires_in,
    refreshExpiresIn: d.refresh_expires_in,
  };
}

module.exports = { buildAuthorizeUrl, exchangeCodeForToken, refreshAccessToken, DEFAULT_SCOPES };
