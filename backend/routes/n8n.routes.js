// Endpoints n8n (self-hosted) calls into. Protected by a shared secret
// header (not JWT) since n8n runs as a separate service, not a browser
// session. Backend stays fully functional if n8n is offline - these
// routes are only invoked when n8n reaches out.
const express = require('express');
const db = require('../config/db');

const router = express.Router();

function requireN8nToken(req, res, next) {
  const token = req.headers['x-n8n-token'];
  if (!token || token !== process.env.N8N_WEBHOOK_TOKEN) {
    return res.status(401).json({ error: 'Invalid n8n token' });
  }
  next();
}

router.use(requireN8nToken);

// n8n reports pipeline step completion (e.g. after calling an external
// render API) back to the backend to keep DB state in sync.
router.post('/webhook/video-status', (req, res) => {
  const { videoId, status, filePath, thumbnailPath, failReason } = req.body || {};
  if (!videoId || !status) return res.status(400).json({ error: 'videoId and status required' });

  db.prepare(
    `UPDATE videos SET status = ?, file_path = COALESCE(?, file_path),
     thumbnail_path = COALESCE(?, thumbnail_path), fail_reason = ? WHERE id = ?`
  ).run(status, filePath || null, thumbnailPath || null, failReason || null, videoId);

  res.json({ ok: true });
});

// n8n reports scheduled platform performance sync (views/clicks/orders).
router.post('/webhook/performance-sync', (req, res) => {
  const { videoId, date, views = 0, clicks = 0, orders = 0, commission = 0 } = req.body || {};
  if (!videoId || !date) return res.status(400).json({ error: 'videoId and date required' });

  db.prepare(
    `INSERT INTO performance_metrics (video_id, date, views, clicks, orders, commission, source)
     VALUES (?, ?, ?, ?, ?, ?, 'platform_sync')`
  ).run(videoId, date, views, clicks, orders, commission);

  res.json({ ok: true });
});

router.get('/health', (req, res) => res.json({ ok: true }));

module.exports = router;
