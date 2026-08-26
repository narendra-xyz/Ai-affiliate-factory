// Fetches real video performance stats via TikTok's official video query
// endpoint (Display API). Only works if the connected account has the
// `video.list` scope granted. Views/likes/comments/shares map directly;
// TikTok's content API does NOT provide affiliate conversion data
// (clicks/orders/commission) - that continues to come from the
// affiliate provider's own tracking (already wired via /finance/earnings
// or the existing n8n performance-sync workflow), never invented here.
const { callTikTokApi } = require('./tiktokClient');
const { getValidAccessToken } = require('./tiktokTokenManager');
const { hasScope } = require('./tiktokPublish.adapter');

const FIELDS = 'id,view_count,like_count,comment_count,share_count';

/**
 * @returns {Promise<{ok:boolean, stats?:object, error?:string, missingScope?:boolean}>}
 */
async function fetchVideoStats({ accountId, tiktokPostId }) {
  const tokenResult = await getValidAccessToken(accountId);
  if (!tokenResult.ok) return { ok: false, error: tokenResult.error, notConfigured: tokenResult.notConfigured };

  if (!hasScope(tokenResult.account, 'video.list')) {
    return {
      ok: false,
      missingScope: true,
      error: 'Account TikTok ini belum memiliki permission "video.list" untuk mengambil statistik video.',
    };
  }

  const res = await callTikTokApi('/v2/video/query/', {
    method: 'POST',
    accessToken: tokenResult.accessToken,
    query: { fields: FIELDS },
    body: { filters: { video_ids: [tiktokPostId] } },
  });

  if (!res.ok) return { ok: false, error: res.error || 'Failed to fetch video stats', tokenExpired: res.tokenExpired };

  const video = (res.data?.data?.videos || [])[0];
  if (!video) return { ok: false, error: 'TikTok returned no data for this video id (may still be processing)' };

  return {
    ok: true,
    stats: {
      views: video.view_count || 0,
      likes: video.like_count || 0,
      comments: video.comment_count || 0,
      shares: video.share_count || 0,
    },
  };
}

module.exports = { fetchVideoStats };
