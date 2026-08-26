// Central place that resolves a USABLE TikTok Shop access token: decrypts
// the stored token, refreshes it transparently if expired/near-expiry,
// and persists new tokens back encrypted. Mirrors
// tiktok/tiktokTokenManager.js's pattern exactly, but operates on
// tiktok_shop_accounts (a separate table/credential set) since TikTok
// Shop tokens are entirely independent of general TikTok Login tokens.
const db = require('../../../config/db');
const logger = require('../../../utils/logger');
const { encrypt, decrypt } = require('../tiktok/tokenCrypto'); // reused as-is - generic AES helper, not TikTok-Login-specific
const { refreshAccessToken } = require('./tiktokShopAuth.adapter');

const REFRESH_MARGIN_SECONDS = 120;

/**
 * @returns {Promise<{ok:boolean, accessToken?:string, account?:object, error?:string, notConfigured?:boolean}>}
 */
async function getValidAccessToken(shopAccountId) {
  const account = db.prepare('SELECT * FROM tiktok_shop_accounts WHERE id = ?').get(shopAccountId);
  if (!account) return { ok: false, error: `TikTok Shop account ${shopAccountId} not found` };
  if (account.status === 'disconnected') return { ok: false, error: 'Account is disconnected' };

  const expiresAt = account.access_token_expires_at ? new Date(account.access_token_expires_at).getTime() : 0;
  const stillValid = expiresAt - REFRESH_MARGIN_SECONDS * 1000 > Date.now();

  if (stillValid) {
    try {
      return { ok: true, accessToken: decrypt(account.access_token_enc), account };
    } catch (err) {
      if (err.code === 'NOT_CONFIGURED') return { ok: false, notConfigured: true, error: err.message };
      return { ok: false, error: `Failed to decrypt stored token: ${err.message}` };
    }
  }

  let refreshTokenPlain;
  try {
    refreshTokenPlain = decrypt(account.refresh_token_enc);
  } catch (err) {
    if (err.code === 'NOT_CONFIGURED') return { ok: false, notConfigured: true, error: err.message };
    return { ok: false, error: `Failed to decrypt refresh token: ${err.message}` };
  }

  const refreshExpiresAt = account.refresh_token_expires_at ? new Date(account.refresh_token_expires_at).getTime() : 0;
  if (refreshExpiresAt && refreshExpiresAt <= Date.now()) {
    db.prepare(`UPDATE tiktok_shop_accounts SET status = 'expired', last_error = ? WHERE id = ?`).run(
      'Refresh token expired - reconnect required',
      shopAccountId
    );
    return { ok: false, error: 'Refresh token expired. TikTok Shop account needs to be reconnected.' };
  }

  const refreshed = await refreshAccessToken(refreshTokenPlain);
  if (!refreshed.ok) {
    const status = refreshed.tokenExpired ? 'expired' : 'error';
    db.prepare(`UPDATE tiktok_shop_accounts SET status = ?, last_error = ? WHERE id = ?`).run(status, refreshed.error, shopAccountId);
    logger.log('tiktok_shop', 'error', `Token refresh failed for shop account ${shopAccountId}`, { error: refreshed.error });
    return { ok: false, error: refreshed.error };
  }

  const newAccessExpiresAt = new Date(Date.now() + refreshed.expiresIn * 1000).toISOString();
  const newRefreshExpiresAt = refreshed.refreshExpiresIn
    ? new Date(Date.now() + refreshed.refreshExpiresIn * 1000).toISOString()
    : account.refresh_token_expires_at;

  db.prepare(
    `UPDATE tiktok_shop_accounts SET access_token_enc = ?, refresh_token_enc = ?,
     access_token_expires_at = ?, refresh_token_expires_at = ?, status = 'connected',
     last_error = NULL, updated_at = datetime('now') WHERE id = ?`
  ).run(encrypt(refreshed.accessToken), encrypt(refreshed.refreshToken), newAccessExpiresAt, newRefreshExpiresAt, shopAccountId);

  logger.log('tiktok_shop', 'info', `TikTok Shop access token refreshed for account ${shopAccountId}`);

  const updatedAccount = db.prepare('SELECT * FROM tiktok_shop_accounts WHERE id = ?').get(shopAccountId);
  return { ok: true, accessToken: refreshed.accessToken, account: updatedAccount };
}

module.exports = { getValidAccessToken };
