// Orchestrates the full shoppable video publish flow:
//   precheck -> upload (with product_link_info) -> poll status
// tracking video_status and product_attachment_status SEPARATELY in
// tiktok_shop_publishes (spec point 10) - a video is never reported as
// "fully published" if its product attachment failed independently.
// This is a purely additive orchestration layer: it does not modify
// Product Hunter, Money Agent, or any existing agent/pipeline file.
const db = require('../config/db');
const logger = require('../utils/logger');
const { precheckShoppableContent, uploadShoppableVideo, pollPublishStatus } = require('./adapters/tiktok-shop/tiktokShopVideo.adapter');

async function publishShoppableVideo({ videoId, shopAccountId, tiktokShopProductId, internalProductId, caption }) {
  const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(videoId);
  if (!video) throw new Error(`Video ${videoId} not found`);
  if (!video.file_path) throw new Error('Video has no rendered file to publish');

  const insertRes = db
    .prepare(
      `INSERT INTO tiktok_shop_publishes
       (video_id, internal_product_id, shop_account_id, tiktok_shop_product_id, caption, video_status, product_attachment_status)
       VALUES (?, ?, ?, ?, ?, 'queued', 'not_attempted')`
    )
    .run(videoId, internalProductId, shopAccountId, tiktokShopProductId, caption || '');
  const publishRowId = insertRes.lastInsertRowid;

  try {
    // Step 1: precheck (best-effort - 'not_available' does not block the flow).
    const videoSize = require('fs').statSync(video.file_path).size;
    const precheck = await precheckShoppableContent({ shopAccountId, productId: tiktokShopProductId, videoSize });

    db.prepare(`UPDATE tiktok_shop_publishes SET precheck_status = ?, precheck_result = ?, updated_at = datetime('now') WHERE id = ?`).run(
      precheck.status,
      JSON.stringify(precheck.result || precheck.error || null),
      publishRowId
    );

    if (precheck.status === 'failed') {
      db.prepare(`UPDATE tiktok_shop_publishes SET video_status = 'failed', video_error = ? WHERE id = ?`).run(
        `Precheck gagal: ${precheck.error || 'Konten tidak lolos precheck shoppable video'}`,
        publishRowId
      );
      return { publishRowId, videoStatus: 'failed', productAttachmentStatus: 'not_attempted' };
    }

    // Step 2: upload (with product_link_info attached at init).
    db.prepare(`UPDATE tiktok_shop_publishes SET video_status = 'uploading', updated_at = datetime('now') WHERE id = ?`).run(publishRowId);

    const uploadResult = await uploadShoppableVideo({
      shopAccountId,
      filePath: video.file_path,
      caption,
      tiktokShopProductId,
    });

    if (!uploadResult.ok) {
      db.prepare(`UPDATE tiktok_shop_publishes SET video_status = 'failed', video_error = ? WHERE id = ?`).run(uploadResult.error, publishRowId);
      logger.log('tiktok_shop', 'error', `Shoppable upload failed for video ${videoId}`, { error: uploadResult.error });
      return { publishRowId, videoStatus: 'failed', productAttachmentStatus: 'not_attempted', error: uploadResult.error };
    }

    db.prepare(`UPDATE tiktok_shop_publishes SET video_status = 'processing', request_id = ?, updated_at = datetime('now') WHERE id = ?`).run(
      uploadResult.requestId,
      publishRowId
    );

    // Step 3: poll for terminal status - video and product attachment
    // are evaluated and stored independently.
    const statusResult = await pollPublishStatus({ shopAccountId, requestId: uploadResult.requestId });

    db.prepare(
      `UPDATE tiktok_shop_publishes SET video_status = ?, product_attachment_status = ?, tiktok_video_id = ?,
       video_error = ?, attachment_error = ?, published_at = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(
      statusResult.videoStatus,
      statusResult.productAttachmentStatus,
      statusResult.tiktokVideoId || null,
      statusResult.videoError || null,
      statusResult.attachmentError || null,
      statusResult.videoStatus === 'published' ? new Date().toISOString() : null,
      publishRowId
    );

    // The internal video row only reflects "published" once the video
    // itself is confirmed published - product attachment failure alone
    // does NOT block marking the video as published, but is visible
    // separately via product_attachment_status so it's never silently lost.
    if (statusResult.videoStatus === 'published') {
      db.prepare(`UPDATE videos SET status = 'published', published_at = datetime('now') WHERE id = ?`).run(videoId);
    }

    if (statusResult.videoStatus === 'published' && statusResult.productAttachmentStatus !== 'attached') {
      logger.log('tiktok_shop', 'warn', `Video ${videoId} published but product attachment did not succeed`, {
        productAttachmentStatus: statusResult.productAttachmentStatus,
        attachmentError: statusResult.attachmentError,
      });
    }

    return {
      publishRowId,
      videoStatus: statusResult.videoStatus,
      productAttachmentStatus: statusResult.productAttachmentStatus,
      tiktokVideoId: statusResult.tiktokVideoId,
    };
  } catch (err) {
    db.prepare(`UPDATE tiktok_shop_publishes SET video_status = 'failed', video_error = ? WHERE id = ?`).run(err.message, publishRowId);
    logger.log('tiktok_shop', 'error', `Shoppable publish crashed for video ${videoId}`, { error: err.message });
    return { publishRowId, videoStatus: 'failed', productAttachmentStatus: 'not_attempted', error: err.message };
  }
}

module.exports = { publishShoppableVideo };
