// Aggregated data for the main dashboard page: today/month video counts,
// product testing count, totals, agent statuses, and server resource use.
const express = require('express');
const db = require('../config/db');
const { calculateFinancials } = require('../services/financeCalculator.service');
const { getResourceStatus, getStorageStatus, getN8nStatus } = require('../services/systemMonitor.service');

const router = express.Router();

router.get('/summary', async (req, res) => {
  const videosToday = db
    .prepare(`SELECT COUNT(*) as n FROM videos WHERE date(created_at) = date('now')`)
    .get().n;
  const videosThisMonth = db
    .prepare(`SELECT COUNT(*) as n FROM videos WHERE strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')`)
    .get().n;
  const videosSuccess = db
    .prepare(`SELECT COUNT(*) as n FROM videos WHERE status IN ('published','ready_to_publish','approved')`)
    .get().n;
  const videosFailed = db.prepare(`SELECT COUNT(*) as n FROM videos WHERE status = 'failed'`).get().n;
  const productsTesting = db.prepare(`SELECT COUNT(*) as n FROM products WHERE status = 'testing'`).get().n;

  const totals = db
    .prepare(
      `SELECT COALESCE(SUM(views),0) as views, COALESCE(SUM(clicks),0) as clicks,
              COALESCE(SUM(orders),0) as orders, COALESCE(SUM(commission),0) as commission
       FROM performance_metrics`
    )
    .get();

  const agents = db.prepare(`SELECT name, display_name, status, current_task, last_task FROM agents`).all();
  const finance = calculateFinancials();
  const resources = getResourceStatus();
  const storage = await getStorageStatus('/');
  const n8n = await getN8nStatus();

  res.json({
    videos: { today: videosToday, thisMonth: videosThisMonth, success: videosSuccess, failed: videosFailed },
    productsTesting,
    totals,
    finance,
    agents,
    server: { resources, storage, n8n },
  });
});

// Simple time-series for charts: views/clicks/orders/commission/profit
// over the last N days. Profit per day = commission - AI cost that day -
// prorated server cost that day - other expenses that day.
router.get('/timeseries', (req, res) => {
  const days = Math.min(parseInt(req.query.days || '30', 10), 90);

  const perf = db
    .prepare(
      `SELECT date, SUM(views) as views, SUM(clicks) as clicks, SUM(orders) as orders, SUM(commission) as commission
       FROM performance_metrics
       WHERE date >= date('now', ?)
       GROUP BY date ORDER BY date ASC`
    )
    .all(`-${days} days`);

  const aiCostByDay = db
    .prepare(
      `SELECT date(created_at) as date, SUM(estimated_cost) as cost FROM ai_usage
       WHERE created_at >= datetime('now', ?) GROUP BY date(created_at)`
    )
    .all(`-${days} days`);
  const aiCostMap = Object.fromEntries(aiCostByDay.map((r) => [r.date, r.cost]));

  const otherCostByDay = db
    .prepare(
      `SELECT date(date) as day, SUM(amount) as cost FROM expenses
       WHERE date >= datetime('now', ?) AND category != 'server' GROUP BY date(date)`
    )
    .all(`-${days} days`);
  const otherCostMap = Object.fromEntries(otherCostByDay.map((r) => [r.day, r.cost]));

  const serverMonthlyRow = db.prepare(`SELECT value FROM settings WHERE key = 'server_cost_monthly'`).get();
  const serverDailyCost = parseFloat(serverMonthlyRow?.value || '72000') / 30;

  const series = perf.map((r) => {
    const aiCost = aiCostMap[r.date] || 0;
    const otherCost = otherCostMap[r.date] || 0;
    const profit = (r.commission || 0) - aiCost - serverDailyCost - otherCost;
    return { ...r, aiCost, serverCost: +serverDailyCost.toFixed(2), otherCost, profit: +profit.toFixed(2) };
  });

  res.json({ days, series });
});

// Top products and top videos by profit, plus overall conversion rate -
// quick-glance panels for the main dashboard.
router.get('/top', (req, res) => {
  const topProducts = db
    .prepare(
      `SELECT p.id, p.name, COALESCE(SUM(m.commission),0) as commission,
              COALESCE((SELECT SUM(a.estimated_cost) FROM ai_usage a
                         WHERE a.video_id IN (SELECT id FROM videos WHERE product_id = p.id)
                            OR a.script_id IN (SELECT id FROM scripts WHERE product_id = p.id)), 0) as ai_cost
       FROM products p
       LEFT JOIN videos v ON v.product_id = p.id
       LEFT JOIN performance_metrics m ON m.video_id = v.id
       GROUP BY p.id
       ORDER BY (commission - ai_cost) DESC
       LIMIT 5`
    )
    .all()
    .map((r) => ({ ...r, profit: +(r.commission - r.ai_cost).toFixed(2) }));

  const topVideos = db
    .prepare(
      `SELECT v.id, v.title, v.status, COALESCE(SUM(m.views),0) as views, COALESCE(SUM(m.commission),0) as commission,
              COALESCE((SELECT SUM(a1.estimated_cost) FROM ai_usage a1 WHERE a1.video_id = v.id), 0) +
              COALESCE((SELECT SUM(a2.estimated_cost) FROM ai_usage a2 WHERE a2.script_id = v.script_id), 0) as ai_cost
       FROM videos v
       LEFT JOIN performance_metrics m ON m.video_id = v.id
       GROUP BY v.id
       ORDER BY (commission - ai_cost) DESC
       LIMIT 5`
    )
    .all()
    .map((r) => ({ ...r, profit: +(r.commission - r.ai_cost).toFixed(2) }));

  const totals = db
    .prepare(`SELECT COALESCE(SUM(clicks),0) as clicks, COALESCE(SUM(orders),0) as orders FROM performance_metrics`)
    .get();
  const conversionRate = totals.clicks ? +((totals.orders / totals.clicks) * 100).toFixed(2) : 0;

  res.json({ topProducts, topVideos, conversionRate });
});

module.exports = router;
