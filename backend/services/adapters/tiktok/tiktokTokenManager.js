// Central place that resolves a USABLE access token for a given TikTok
// account row: decrypts the stored token, and if it's expired (or about
// to expire), transparently refreshes it via tiktokAuth.adapter and
// persists the new tokens back to the DB - encrypted, never plaintext.
// Every other TikTok adapter (publish, account, analytics) goes through
// this instead of reading tiktok_accounts.access_token_enc directly, so
// token refresh logic lives in exactly one place.
const db = require('../../../config/db');
const logger = require('../../../utils/logger');
const { encrypt, decrypt } = require('./tokenCrypto');
const { refreshAccessToken } = require('./tiktokAuth.adapter');

const REFRESH_MARGIN_SECONDS = 120; // refresh a bit before actual expiry

/**
 * @returns {Promise<{ok:boolean, accessToken?:string, account?:object, error?:string, notConfigured?:boolean}>}
 */
async function getValidAccessToken(accountId) {
  const account = db.prepare('SELECT * FROM tiktok_accounts WHERE id = ?').get(accountId);
  if (!account) return { ok: false, error: `TikTok account ${accountId} not found` };
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

  // Needs refresh.
  let refreshTokenPlain;
  try {
    refreshTokenPlain = decrypt(account.refresh_token_enc);
  } catch (err) {
    if (err.code === 'NOT_CONFIGURED') return { ok: false, notConfigured: true, error: err.message };
    return { ok: false, error: `Failed to decrypt refresh token: ${err.message}` };
  }

  const refreshExpiresAt = account.refresh_token_expires_at ? new Date(account.refresh_token_expires_at).getTime() : 0;
  if (refreshExpiresAt && refreshExpiresAt <= Date.now()) {
    db.prepare(`UPDATE tiktok_accounts SET status = 'expired', last_error = ? WHERE id = ?`).run(
      'Refresh token expired - reconnect required',
      accountId
    );
    return { ok: false, error: 'Refresh token expired. Account needs to be reconnected via OAuth.' };
  }

  const refreshed = await refreshAccessToken(refreshTokenPlain);
  if (!refreshed.ok) {
    const status = refreshed.tokenExpired ? 'expired' : 'error';
    db.prepare(`UPDATE tiktok_accounts SET status = ?, last_error = ? WHERE id = ?`).run(status, refreshed.error, accountId);
    logger.log('tiktok', 'error', `Token refresh failed for account ${accountId}`, { error: refreshed.error });
    return { ok: false, error: refreshed.error };
  }

  const newAccessExpiresAt = new Date(Date.now() + refreshed.expiresIn * 1000).toISOString();
  const newRefreshExpiresAt = refreshed.refreshExpiresIn
    ? new Date(Date.now() + refreshed.refreshExpiresIn * 1000).toISOString()
    : account.refresh_token_expires_at;

  db.prepare(
    `UPDATE tiktok_accounts SET access_token_enc = ?, refresh_token_enc = ?,
     access_token_expires_at = ?, refresh_token_expires_at = ?, status = 'connected',
     last_error = NULL, updated_at = datetime('now') WHERE id = ?`
  ).run(encrypt(refreshed.accessToken), encrypt(refreshed.refreshToken), newAccessExpiresAt, newRefreshExpiresAt, accountId);

  logger.log('tiktok', 'info', `Access token refreshed for account ${accountId}`);

  const updatedAccount = db.prepare('SELECT * FROM tiktok_accounts WHERE id = ?').get(accountId);
  return { ok: true, accessToken: refreshed.accessToken, account: updatedAccount };
}

module.exports = { getValidAccessToken };
