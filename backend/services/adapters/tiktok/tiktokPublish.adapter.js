// TikTok Content Posting API - official video publish flow (FILE_UPLOAD
// method, not PULL_FROM_URL, so our video files never need to be
// publicly reachable):
//   1. POST /v2/post/publish/video/init/  -> get upload_url + publish_id
//   2. PUT the video bytes to upload_url (chunked per TikTok's spec)
//   3. Poll POST /v2/post/publish/status/fetch/ until PUBLISH_COMPLETE
//
// Reference: https://developers.tiktok.com/doc/content-posting-api-get-started
// IMPORTANT: publishing requires the connected account to have been
// granted the `video.publish` scope AND the TikTok app to be in an
// approved/audited state for that scope - unaudited apps are typically
// restricted to private/draft posting only. This adapter surfaces
// whatever TikTok's API actually returns rather than assuming success;
// it has not been tested against a live TikTok app (no network access
// during development).
const fs = require('fs');
const { callTikTokApi, TIKTOK_API_BASE } = require('./tiktokClient');
const { getValidAccessToken } = require('./tiktokTokenManager');
const logger = require('../../../utils/logger');

const CHUNK_SIZE = 10 * 1024 * 1024; // 10MB, within TikTok's documented chunk bounds
const STATUS_POLL_INTERVAL_MS = 3000;
const STATUS_POLL_TIMEOUT_MS = parseInt(process.env.TIKTOK_PUBLISH_TIMEOUT_MS || '180000', 10);

function hasScope(account, scope) {
  return (account.scopes || '').split(/[\s,]+/).includes(scope);
}

/**
 * Initiates a video publish. Returns immediately after TikTok accepts the
 * upload (status still PROCESSING) - caller should poll pollPublishStatus.
 * @returns {Promise<{ok:boolean, publishId?:string, error?:string, notConfigured?:boolean, missingScope?:boolean}>}
 */
async function publishVideo({ accountId, filePath, caption, privacyLevel = 'SELF_ONLY' }) {
  const tokenResult = await getValidAccessToken(accountId);
  if (!tokenResult.ok) return { ok: false, error: tokenResult.error, notConfigured: tokenResult.notConfigured };

  const account = tokenResult.account;
  if (!hasScope(account, 'video.publish')) {
    return {
      ok: false,
      missingScope: true,
      error: 'Account TikTok ini belum memiliki permission "video.publish". Sambungkan ulang akun dan setujui izin publish, atau app belum di-approve TikTok untuk scope ini.',
    };
  }

  if (!fs.existsSync(filePath)) return { ok: false, error: `Video file not found: ${filePath}` };

  const videoSize = fs.statSync(filePath).size;
  const totalChunkCount = Math.max(1, Math.ceil(videoSize / CHUNK_SIZE));

  // Step 1: init
  const initRes = await callTikTokApi('/v2/post/publish/video/init/', {
    method: 'POST',
    accessToken: tokenResult.accessToken,
    body: {
      post_info: {
        title: (caption || '').slice(0, 2200), // TikTok caption length limit
        privacy_level: privacyLevel, // SELF_ONLY unless app is approved for public posting
        disable_duet: false,
        disable_comment: false,
        disable_stitch: false,
      },
      source_info: {
        source: 'FILE_UPLOAD',
        video_size: videoSize,
        chunk_size: Math.min(CHUNK_SIZE, videoSize),
        total_chunk_count: totalChunkCount,
      },
    },
  });

  if (!initRes.ok) {
    return { ok: false, error: initRes.error || 'Failed to initiate TikTok publish', tokenExpired: initRes.tokenExpired };
  }

  const uploadUrl = initRes.data?.data?.upload_url;
  const publishId = initRes.data?.data?.publish_id;
  if (!uploadUrl || !publishId) {
    return { ok: false, error: 'TikTok did not return upload_url/publish_id as expected' };
  }

  // Step 2: upload video bytes (chunked PUT per TikTok's spec).
  try {
    const buffer = fs.readFileSync(filePath);
    for (let i = 0; i < totalChunkCount; i++) {
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, videoSize) - 1;
      const chunk = buffer.subarray(start, end + 1);

      const putRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': 'video/mp4',
          'Content-Range': `bytes ${start}-${end}/${videoSize}`,
          'Content-Length': String(chunk.length),
        },
        body: chunk,
      });

      if (!putRes.ok) {
        const text = await putRes.text().catch(() => '');
        return { ok: false, publishId, error: `Chunk upload failed (${i + 1}/${totalChunkCount}): HTTP ${putRes.status} ${text.slice(0, 200)}` };
      }
    }
  } catch (err) {
    return { ok: false, publishId, error: `Video upload failed: ${err.message}` };
  }

  logger.log('tiktok', 'info', `Video uploaded to TikTok, publish_id=${publishId}, awaiting processing`);
  return { ok: true, publishId };
}

/**
 * Polls TikTok until the publish reaches a terminal state or times out.
 * @returns {Promise<{ok:boolean, status:string, postId?:string, error?:string}>}
 */
async function pollPublishStatus({ accountId, publishId }) {
  const tokenResult = await getValidAccessToken(accountId);
  if (!tokenResult.ok) return { ok: false, status: 'unknown', error: tokenResult.error };

  const deadline = Date.now() + STATUS_POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const res = await callTikTokApi('/v2/post/publish/status/fetch/', {
      method: 'POST',
      accessToken: tokenResult.accessToken,
      body: { publish_id: publishId },
    });

    if (!res.ok) return { ok: false, status: 'unknown', error: res.error };

    const status = res.data?.data?.status; // PROCESSING_DOWNLOAD | PROCESSING_UPLOAD | PUBLISH_COMPLETE | FAILED
    if (status === 'PUBLISH_COMPLETE') {
      const postId = res.data?.data?.publicaly_available_post_id?.[0] || res.data?.data?.post_id || null;
      return { ok: true, status, postId };
    }
    if (status === 'FAILED') {
      return { ok: false, status, error: res.data?.data?.fail_reason || 'TikTok reported publish failure' };
    }

    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, STATUS_POLL_INTERVAL_MS));
  }

  return { ok: false, status: 'timeout', error: `Publish status still pending after ${STATUS_POLL_TIMEOUT_MS}ms` };
}

module.exports = { publishVideo, pollPublishStatus, hasScope };
