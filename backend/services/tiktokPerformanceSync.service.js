// Pulls real stats for every published TikTok video and writes them into
// the EXISTING performance_metrics table (tagged source='tiktok_api') -
// this is the only touch point into the existing analytics/Money Agent
// system, and it's purely additive (new rows, no changes to how Money
// Agent reads that table). Views/likes/comments/shares come from TikTok;
// clicks/orders/commission remain untouched here (those come from the
// affiliate provider's own tracking, already wired elsewhere).
const db = require('../config/db');
const logger = require('../utils/logger');
const { fetchVideoStats } = require('./adapters/tiktok/tiktokAnalytics.adapter');

async function syncAllPublishedVideos() {
  const publishes = db
    .prepare(`SELECT * FROM tiktok_publishes WHERE status = 'published' AND tiktok_post_id IS NOT NULL`)
    .all();

  const results = { synced: 0, failed: 0, skipped: 0, details: [] };

  for (const pub of publishes) {
    // eslint-disable-next-line no-await-in-loop
    const stats = await fetchVideoStats({ accountId: pub.account_id, tiktokPostId: pub.tiktok_post_id });

    if (!stats.ok) {
      results.failed++;
      results.details.push({ videoId: pub.video_id, error: stats.error, notConfigured: stats.notConfigured, missingScope: stats.missingScope });
      logger.log('tiktok', 'warn', `Performance sync failed for video ${pub.video_id}`, { error: stats.error });
      continue;
    }

    const today = new Date().toISOString().slice(0, 10);
    db.prepare(
      `INSERT INTO performance_metrics (video_id, date, views, likes, comments, shares, source)
       VALUES (?, ?, ?, ?, ?, ?, 'tiktok_api')`
    ).run(pub.video_id, today, stats.stats.views, stats.stats.likes, stats.stats.comments, stats.stats.shares);

    results.synced++;
    results.details.push({ videoId: pub.video_id, stats: stats.stats });
  }

  if (results.synced > 0 || results.failed > 0) {
    logger.log('tiktok', 'info', `Performance sync complete: ${results.synced} synced, ${results.failed} failed`);
  }

  return results;
}

module.exports = { syncAllPublishedVideos };
