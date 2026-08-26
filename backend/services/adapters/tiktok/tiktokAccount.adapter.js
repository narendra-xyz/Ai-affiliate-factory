// Fetches basic account info (open_id, username, display_name, avatar)
// via TikTok's official user info endpoint. Used right after OAuth to
// populate tiktok_accounts, and available for a manual "refresh info" too.
const { callTikTokApi } = require('./tiktokClient');
const { getValidAccessToken } = require('./tiktokTokenManager');

const FIELDS = 'open_id,union_id,avatar_url,display_name,username';

/** @returns {Promise<{ok:boolean, info?:object, error?:string}>} */
async function fetchUserInfo(accessToken) {
  const res = await callTikTokApi('/v2/user/info/', {
    method: 'GET',
    accessToken,
    query: { fields: FIELDS },
  });
  if (!res.ok) return { ok: false, error: res.error || 'Failed to fetch user info', tokenExpired: res.tokenExpired };
  return { ok: true, info: res.data?.data?.user || res.data?.user || {} };
}

/** Refreshes stored account info for an already-connected account. */
async function refreshAccountInfo(accountId) {
  const tokenResult = await getValidAccessToken(accountId);
  if (!tokenResult.ok) return tokenResult;

  const infoResult = await fetchUserInfo(tokenResult.accessToken);
  if (!infoResult.ok) return infoResult;

  const db = require('../../../config/db');
  const info = infoResult.info;
  db.prepare(
    `UPDATE tiktok_accounts SET username = ?, display_name = ?, avatar_url = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(info.username || null, info.display_name || null, info.avatar_url || null, accountId);

  return { ok: true, info };
}

module.exports = { fetchUserInfo, refreshAccountInfo };
