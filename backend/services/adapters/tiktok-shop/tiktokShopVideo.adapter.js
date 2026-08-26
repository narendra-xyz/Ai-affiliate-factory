// TikTok Shop Shoppable Video upload/publish - distinct from the plain
// TikTok Content Posting API flow (tiktok/tiktokPublish.adapter.js).
// This is intentionally self-contained (does not import/reuse the
// plain-publish adapter) so the existing Content Posting API flow from
// the previous integration is never touched or put at risk.
//
// Flow: precheck (if available) -> init upload with product_link_info ->
// chunked upload -> poll status -> report video status AND product
// attachment status SEPARATELY, since TikTok can publish the video while
// the product link attachment fails independently.
//
// Reference: https://partner.tiktokshop.com/docv2 (Video/Content section)
// Not tested against a live TikTok Shop Partner app (no network access
// during development) - verify against current docs before production.
const fs = require('fs');
const { callShopApi } = require('./tiktokShopClient');
const { getValidAccessToken } = require('./tiktokShopTokenManager');
const logger = require('../../../utils/logger');

const CHUNK_SIZE = 10 * 1024 * 1024; // 10MB
const STATUS_POLL_INTERVAL_MS = 3000;
const STATUS_POLL_TIMEOUT_MS = parseInt(process.env.TIKTOK_SHOP_PUBLISH_TIMEOUT_MS || '180000', 10);

/**
 * Optional pre-flight check TikTok Shop may expose to validate a video
 * is eligible for shoppable content BEFORE spending an upload attempt on
 * it (e.g. duration/resolution/content-policy checks). If the endpoint
 * isn't available/supported for this app, this returns a clear
 * 'not_available' result rather than blocking the publish flow.
 * @returns {Promise<{ok:boolean, status:'passed'|'failed'|'not_available', result?:object, error?:string}>}
 */
async function precheckShoppableContent({ shopAccountId, productId, videoSize }) {
  const tokenResult = await getValidAccessToken(shopAccountId);
  if (!tokenResult.ok) return { ok: false, status: 'not_available', error: tokenResult.error, notConfigured: tokenResult.notConfigured };

  const res = await callShopApi('/video/202309/videos/precheck', {
    method: 'POST',
    accessToken: tokenResult.accessToken,
    body: { product_id: productId, video_size: videoSize },
  });

  if (res.status === 404 || (!res.ok && /not.?found|not.?support/i.test(res.error || ''))) {
    return { ok: true, status: 'not_available' };
  }
  if (!res.ok) return { ok: false, status: 'failed', error: res.error };

  const passed = res.data?.data?.is_valid !== false;
  return { ok: true, status: passed ? 'passed' : 'failed', result: res.data?.data };
}

/**
 * Initiates a shoppable video upload with product_link_info attached at
 * init time (per spec point 6). Returns after TikTok accepts the upload
 * request - caller should poll pollPublishStatus for terminal state.
 * @returns {Promise<{ok:boolean, requestId?:string, error?:string, notConfigured?:boolean}>}
 */
async function uploadShoppableVideo({ shopAccountId, filePath, caption, tiktokShopProductId }) {
  const tokenResult = await getValidAccessToken(shopAccountId);
  if (!tokenResult.ok) return { ok: false, error: tokenResult.error, notConfigured: tokenResult.notConfigured };

  if (!fs.existsSync(filePath)) return { ok: false, error: `Video file not found: ${filePath}` };
  if (!tiktokShopProductId) return { ok: false, error: 'tiktokShopProductId is required for shoppable video publish' };

  const videoSize = fs.statSync(filePath).size;
  const totalChunkCount = Math.max(1, Math.ceil(videoSize / CHUNK_SIZE));

  // Step 1: init, with product_link_info so the product is attached at
  // creation time rather than as a separate later call.
  const initRes = await callShopApi('/video/202309/videos/init', {
    method: 'POST',
    accessToken: tokenResult.accessToken,
    body: {
      video: { video_size: videoSize, chunk_size: Math.min(CHUNK_SIZE, videoSize), total_chunk_count: totalChunkCount },
      caption: (caption || '').slice(0, 2200),
      product_link_info: {
        product_id: tiktokShopProductId,
        product_link_type: 'PRODUCT_ANCHOR', // shows as a product card/anchor on the video
      },
    },
  });

  if (!initRes.ok) return { ok: false, error: initRes.error || 'Failed to initiate shoppable video upload', tokenExpired: initRes.tokenExpired };

  const uploadUrl = initRes.data?.data?.upload_url;
  const requestId = initRes.data?.data?.publish_id || initRes.data?.request_id || initRes.data?.data?.video_id;
  if (!uploadUrl || !requestId) return { ok: false, error: 'TikTok Shop did not return upload_url/request id as expected' };

  // Step 2: chunked upload.
  try {
    const buffer = fs.readFileSync(filePath);
    for (let i = 0; i < totalChunkCount; i++) {
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, videoSize) - 1;
      const chunk = buffer.subarray(start, end + 1);

      const putRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'video/mp4', 'Content-Range': `bytes ${start}-${end}/${videoSize}`, 'Content-Length': String(chunk.length) },
        body: chunk,
      });

      if (!putRes.ok) {
        const text = await putRes.text().catch(() => '');
        return { ok: false, requestId, error: `Chunk upload failed (${i + 1}/${totalChunkCount}): HTTP ${putRes.status} ${text.slice(0, 200)}` };
      }
    }
  } catch (err) {
    return { ok: false, requestId, error: `Video upload failed: ${err.message}` };
  }

  logger.log('tiktok_shop', 'info', `Shoppable video uploaded, request_id=${requestId}, product_id=${tiktokShopProductId}`);
  return { ok: true, requestId };
}

/**
 * Polls TikTok Shop for BOTH the video publish status and the product
 * attachment status - these are reported and returned SEPARATELY (spec
 * point 10) since a video can finish publishing while its product link
 * attachment is still pending or fails independently.
 * @returns {Promise<{ok:boolean, videoStatus:string, productAttachmentStatus:string, tiktokVideoId?:string, videoError?:string, attachmentError?:string}>}
 */
async function pollPublishStatus({ shopAccountId, requestId }) {
  const tokenResult = await getValidAccessToken(shopAccountId);
  if (!tokenResult.ok) {
    return { ok: false, videoStatus: 'unknown', productAttachmentStatus: 'unknown', videoError: tokenResult.error };
  }

  const deadline = Date.now() + STATUS_POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const res = await callShopApi('/video/202309/videos/status', {
      method: 'GET',
      accessToken: tokenResult.accessToken,
      query: { publish_id: requestId },
    });

    if (!res.ok) return { ok: false, videoStatus: 'unknown', productAttachmentStatus: 'unknown', videoError: res.error };

    const d = res.data?.data || {};
    // Documented-shape status fields - video publish status is distinct
    // from product link status; verify exact field names against current
    // TikTok Shop docs before production.
    const videoStatus = mapVideoStatus(d.status);
    const attachmentStatus = mapAttachmentStatus(d.product_link_status);

    if (videoStatus === 'published' || videoStatus === 'failed') {
      return {
        ok: videoStatus === 'published',
        videoStatus,
        productAttachmentStatus: attachmentStatus,
        tiktokVideoId: d.video_id || d.item_id || null,
        videoError: videoStatus === 'failed' ? (d.fail_reason || 'TikTok Shop reported video publish failure') : undefined,
        attachmentError: attachmentStatus === 'failed' ? (d.product_link_fail_reason || 'Product attachment failed') : undefined,
      };
    }

    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, STATUS_POLL_INTERVAL_MS));
  }

  return {
    ok: false,
    videoStatus: 'timeout',
    productAttachmentStatus: 'unknown',
    videoError: `Status still pending after ${STATUS_POLL_TIMEOUT_MS}ms`,
  };
}

function mapVideoStatus(raw) {
  const map = {
    PROCESSING_UPLOAD: 'processing', PROCESSING_DOWNLOAD: 'processing',
    PUBLISH_COMPLETE: 'published', FAILED: 'failed',
  };
  return map[raw] || 'processing';
}

function mapAttachmentStatus(raw) {
  const map = { PENDING: 'pending', SUCCESS: 'attached', ATTACHED: 'attached', FAILED: 'failed' };
  return map[raw] || (raw ? 'pending' : 'not_attempted');
}

module.exports = { precheckShoppableContent, uploadShoppableVideo, pollPublishStatus };
