const express = require('express');
const path = require('path');
const { z } = require('zod');
const db = require('../config/db');
const { validateBody } = require('../middleware/validate.middleware');
const { agentQueue } = require('../services/queue.service');
const TrendHunterAgent = require('../agents/trendHunter.agent');
const ScriptWriterAgent = require('../agents/scriptWriter.agent');
const ContentAgent = require('../agents/contentAgent');
const CriticAgent = require('../agents/criticAgent');
const { LOCAL_PERMANENT_DIR } = require('../services/adapters/storage.adapter');

const router = express.Router();
const trendHunter = new TrendHunterAgent();
const scriptWriter = new ScriptWriterAgent();
const contentAgent = new ContentAgent();
const criticAgent = new CriticAgent();

// Converts an absolute filesystem path (local_permanent storage) into a
// browser-usable URL under the /media/videos static route. If file_path
// is already a URL (e.g. future remote_object_storage), it's passed
// through unchanged. Never exposes the raw server filesystem path to
// the client. Video/image tags can't set an Authorization header, so
// the JWT is appended as a query param (validated by requireAuthOrQueryToken).
function toMediaUrl(absolutePathOrUrl, token) {
  if (!absolutePathOrUrl) return null;
  if (/^https?:\/\//.test(absolutePathOrUrl)) return absolutePathOrUrl;
  const filename = path.basename(absolutePathOrUrl);
  return `/media/videos/${filename}${token ? `?token=${encodeURIComponent(token)}` : ''}`;
}

function withMediaUrls(video, req) {
  // Re-issue a short-lived reference to the same token already used to
  // authenticate this request, so the returned media URLs work in <video>/<img>.
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  return {
    ...video,
    file_path: toMediaUrl(video.file_path, token),
    thumbnail_path: toMediaUrl(video.thumbnail_path, token),
  };
}

// List videos with filters: date, product, status, performance, profit.
// AI cost per video is attributed from ai_usage rows tagged with this
// video's id directly, plus the script-writing/critique cost tagged with
// its script_id - this is a direct-cost view (excludes shared server
// cost, which isn't allocable per video) used as "profit" per video.
router.get('/', (req, res) => {
  const { status, productId, from, to, sortBy, minViews } = req.query;
  let query = `
    SELECT v.*, p.name as product_name,
           COALESCE(SUM(m.views),0) as views, COALESCE(SUM(m.clicks),0) as clicks,
           COALESCE(SUM(m.orders),0) as orders, COALESCE(SUM(m.commission),0) as commission,
           COALESCE((SELECT SUM(a1.estimated_cost) FROM ai_usage a1 WHERE a1.video_id = v.id), 0) +
           COALESCE((SELECT SUM(a2.estimated_cost) FROM ai_usage a2 WHERE a2.script_id = v.script_id), 0) as ai_cost,
           (SELECT tp.status FROM tiktok_publishes tp WHERE tp.video_id = v.id ORDER BY tp.created_at DESC LIMIT 1) as tiktok_status
    FROM videos v
    LEFT JOIN products p ON p.id = v.product_id
    LEFT JOIN performance_metrics m ON m.video_id = v.id
    WHERE 1=1
  `;
  const params = [];
  if (status) { query += ' AND v.status = ?'; params.push(status); }
  if (productId) { query += ' AND v.product_id = ?'; params.push(productId); }
  if (from) { query += ' AND date(v.created_at) >= ?'; params.push(from); }
  if (to) { query += ' AND date(v.created_at) <= ?'; params.push(to); }
  query += ' GROUP BY v.id';
  if (minViews && !Number.isNaN(parseInt(minViews, 10))) {
    query += ' HAVING views >= ' + parseInt(minViews, 10);
  }

  if (sortBy === 'profit') query += ' ORDER BY (commission - ai_cost) DESC';
  else if (sortBy === 'commission') query += ' ORDER BY commission DESC';
  else if (sortBy === 'views') query += ' ORDER BY views DESC';
  else if (sortBy === 'orders') query += ' ORDER BY orders DESC';
  else query += ' ORDER BY v.created_at DESC';

  const rows = db.prepare(query).all(...params);
  res.json(rows.map((r) => withMediaUrls({ ...r, profit: +(r.commission - r.ai_cost).toFixed(2) }, req)));
});

router.get('/:id', (req, res) => {
  const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.id);
  if (!video) return res.status(404).json({ error: 'Not found' });
  const script = db.prepare('SELECT * FROM scripts WHERE id = ?').get(video.script_id);

  const costRow = db
    .prepare(
      `SELECT
         COALESCE((SELECT SUM(estimated_cost) FROM ai_usage WHERE video_id = ?), 0) +
         COALESCE((SELECT SUM(estimated_cost) FROM ai_usage WHERE script_id = ?), 0) as ai_cost`
    )
    .get(video.id, video.script_id);

  const commissionRow = db
    .prepare(`SELECT COALESCE(SUM(commission),0) as commission FROM performance_metrics WHERE video_id = ?`)
    .get(video.id);

  const metricsSourceRow = db
    .prepare(
      `SELECT
         SUM(CASE WHEN source = 'platform_sync' THEN 1 ELSE 0 END) as platformSyncCount,
         SUM(CASE WHEN source = 'manual' THEN 1 ELSE 0 END) as manualCount
       FROM performance_metrics WHERE video_id = ?`
    )
    .get(video.id);
  const metricsSource = !metricsSourceRow.platformSyncCount && !metricsSourceRow.manualCount
    ? 'unavailable'
    : metricsSourceRow.platformSyncCount > 0 && metricsSourceRow.manualCount > 0
    ? 'mixed'
    : metricsSourceRow.platformSyncCount > 0
    ? 'platform_sync'
    : 'manual';

  res.json(withMediaUrls({
    ...video,
    script,
    ai_cost: costRow.ai_cost,
    commission: commissionRow.commission,
    profit: +(commissionRow.commission - costRow.ai_cost).toFixed(2),
    metricsSource,
  }, req));
});

router.post('/pipeline/trends', async (req, res) => {
  const result = await agentQueue.push(() => trendHunter.execute('hunt_trends', req.body));
  res.json(result);
});

router.post('/pipeline/scripts', async (req, res) => {
  const result = await agentQueue.push(() => scriptWriter.execute('write_scripts', req.body));
  res.json(result);
});

router.post('/pipeline/critique-script', async (req, res) => {
  const result = await agentQueue.push(() => criticAgent.execute('critique_script', req.body));
  res.json(result);
});

router.post('/pipeline/generate', async (req, res) => {
  const result = await contentAgent.execute('generate_video', req.body);
  res.json(result);
});

router.post('/pipeline/critique-video', async (req, res) => {
  const result = await agentQueue.push(() => criticAgent.execute('critique_video', req.body));
  res.json(result);
});

const statusSchema = z.object({
  status: z.enum(['draft', 'review', 'approved', 'ready_to_publish', 'published', 'failed']),
});

router.patch('/:id/status', validateBody(statusSchema), (req, res) => {
  const publishedAt = req.body.status === 'published' ? `, published_at = datetime('now')` : '';
  db.prepare(`UPDATE videos SET status = ? ${publishedAt} WHERE id = ?`).run(req.body.status, req.params.id);
  res.json({ ok: true });
});

// Manual retry for a failed video: resets it to draft and re-queues
// generation. Never re-runs anything automatically without this call -
// keeps retries an explicit operator/command-center action.
router.post('/:id/retry', async (req, res) => {
  const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.id);
  if (!video) return res.status(404).json({ error: 'Video not found' });
  if (video.status !== 'failed') return res.status(400).json({ error: 'Only failed videos can be retried' });

  db.prepare(`UPDATE videos SET status = 'draft', fail_reason = NULL WHERE id = ?`).run(video.id);

  const contentAgent = new ContentAgent();
  const result = await contentAgent.execute('generate_video', {
    scriptId: video.script_id,
    platform: video.platform,
    videoId: video.id,
  });
  res.json(result);
});

module.exports = router;
