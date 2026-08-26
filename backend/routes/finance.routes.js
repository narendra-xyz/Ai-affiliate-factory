const express = require('express');
const { z } = require('zod');
const db = require('../config/db');
const { validateBody } = require('../middleware/validate.middleware');
const { calculateFinancials, productRanking, getSetting } = require('../services/financeCalculator.service');

const router = express.Router();

router.get('/snapshot', (req, res) => res.json(calculateFinancials()));
router.get('/products-ranking', (req, res) => res.json(productRanking()));

router.get('/settings', (req, res) => {
  res.json({
    serverCostMonthly: getSetting('server_cost_monthly', '72000'),
    otherCostMonthly: getSetting('other_cost_monthly', '0'),
    maxProductPrice: getSetting('max_product_price', ''),
  });
});

const settingsSchema = z.object({
  serverCostMonthly: z.number().nonnegative().optional(),
  otherCostMonthly: z.number().nonnegative().optional(),
  maxProductPrice: z.number().nonnegative().optional(),
});

router.patch('/settings', validateBody(settingsSchema), (req, res) => {
  const map = {
    serverCostMonthly: 'server_cost_monthly',
    otherCostMonthly: 'other_cost_monthly',
    maxProductPrice: 'max_product_price',
  };
  const upsert = db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
  );
  for (const [bodyKey, dbKey] of Object.entries(map)) {
    if (req.body[bodyKey] !== undefined) upsert.run(dbKey, String(req.body[bodyKey]));
  }
  res.json({ ok: true });
});

const expenseSchema = z.object({
  category: z.enum(['server', 'ai', 'other']),
  description: z.string().optional(),
  amount: z.number().positive(),
});

router.post('/expenses', validateBody(expenseSchema), (req, res) => {
  const { category, description, amount } = req.body;
  const result = db
    .prepare('INSERT INTO expenses (category, description, amount) VALUES (?, ?, ?)')
    .run(category, description || '', amount);
  res.json({ id: result.lastInsertRowid });
});

// Records real affiliate earnings, e.g. from a webhook/manual entry synced
// via the affiliate platform (Lynk.id, etc).
const earningSchema = z.object({
  productId: z.number().int(),
  videoId: z.number().int().optional(),
  orderRef: z.string().optional(),
  amount: z.number().positive(),
});

router.post('/earnings', validateBody(earningSchema), (req, res) => {
  const { productId, videoId, orderRef, amount } = req.body;
  db.prepare('INSERT INTO affiliate_earnings (product_id, video_id, order_ref, amount) VALUES (?, ?, ?, ?)').run(
    productId,
    videoId || null,
    orderRef || '',
    amount
  );
  if (videoId) {
    // Note: performance_metrics has no UNIQUE constraint on (video_id, date)
    // by design - every earning event is recorded as its own row and
    // aggregated with SUM() everywhere it's read, so multiple orders on
    // the same video/day are correctly additive rather than overwritten.
    db.prepare(
      `INSERT INTO performance_metrics (video_id, date, orders, commission, source) VALUES (?, date('now'), 1, ?, 'manual')`
    ).run(videoId, amount);
  }
  res.json({ ok: true });
});

module.exports = router;
