const express = require('express');
const { z } = require('zod');
const db = require('../config/db');
const { validateBody } = require('../middleware/validate.middleware');
const { agentQueue } = require('../services/queue.service');
const ProductHunterAgent = require('../agents/productHunter.agent');
const { productRanking, getSetting } = require('../services/financeCalculator.service');

const STATUS_ENUM = z.enum(['testing', 'active', 'paused', 'rejected']);

const router = express.Router();
const productHunter = new ProductHunterAgent();

router.get('/', (req, res) => {
  const { status, niche } = req.query;
  let query = 'SELECT * FROM products WHERE 1=1';
  const params = [];
  if (status) { query += ' AND status = ?'; params.push(status); }
  if (niche) { query += ' AND niche = ?'; params.push(niche); }
  query += ' ORDER BY score DESC';
  res.json(db.prepare(query).all(...params));
});

router.get('/ranking', (req, res) => {
  const { status, niche, limit } = req.query;
  res.json(productRanking(parseInt(limit || '20', 10), { status, niche }));
});

// Full detail for a single product: its stats plus every video made for it.
router.get('/:id', (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.status(404).json({ error: 'Not found' });

  const stats = db
    .prepare(
      `SELECT COUNT(DISTINCT v.id) as total_videos,
              COALESCE(SUM(m.views),0) as total_views,
              COALESCE(SUM(m.clicks),0) as total_clicks,
              COALESCE(SUM(m.orders),0) as total_orders,
              COALESCE(SUM(m.commission),0) as commission,
              COALESCE(AVG(v.critic_rating),0) as avg_rating
       FROM products p
       LEFT JOIN videos v ON v.product_id = p.id
       LEFT JOIN performance_metrics m ON m.video_id = v.id
       WHERE p.id = ?`
    )
    .get(req.params.id);

  const costRow = db
    .prepare(
      `SELECT COALESCE(SUM(a.estimated_cost), 0) as ai_cost FROM ai_usage a
       WHERE a.video_id IN (SELECT id FROM videos WHERE product_id = ?)
          OR a.script_id IN (SELECT id FROM scripts WHERE product_id = ?)`
    )
    .get(req.params.id, req.params.id);

  const videos = db
    .prepare(
      `SELECT v.id, v.title, v.status, v.platform, v.critic_rating, v.created_at,
              COALESCE(SUM(m.views),0) as views, COALESCE(SUM(m.clicks),0) as clicks,
              COALESCE(SUM(m.orders),0) as orders, COALESCE(SUM(m.commission),0) as commission
       FROM videos v LEFT JOIN performance_metrics m ON m.video_id = v.id
       WHERE v.product_id = ? GROUP BY v.id ORDER BY v.created_at DESC`
    )
    .all(req.params.id);

  res.json({
    ...product,
    stats: {
      ...stats,
      ai_cost: costRow.ai_cost,
      profit: +(stats.commission - costRow.ai_cost).toFixed(2),
      conversion_rate: stats.total_clicks ? +((stats.total_orders / stats.total_clicks) * 100).toFixed(2) : 0,
      avg_views_per_video: stats.total_videos ? Math.round(stats.total_views / stats.total_videos) : 0,
    },
    videos,
  });
});

const huntSchema = z.object({
  niche: z.string().optional(),
  maxPrice: z.number().positive().optional(),
  count: z.number().int().min(1).max(20).optional(),
});

router.post('/hunt', validateBody(huntSchema), async (req, res) => {
  // Enforce the global max-price setting (settable via Command Center /
  // dashboard) as a hard floor, even if the request tries to go higher.
  const globalMax = getSetting('max_product_price', '');
  const input = { ...req.body };
  if (globalMax) {
    input.maxPrice = input.maxPrice ? Math.min(input.maxPrice, parseFloat(globalMax)) : parseFloat(globalMax);
  }

  const result = await agentQueue.push(() => productHunter.execute('hunt_products', input));
  res.json(result);
});

router.patch('/:id/status', validateBody(z.object({ status: STATUS_ENUM })), (req, res) => {
  db.prepare(`UPDATE products SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(
    req.body.status,
    req.params.id
  );
  res.json({ ok: true });
});

module.exports = router;
