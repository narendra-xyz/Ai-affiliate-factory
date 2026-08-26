// Computes Net Profit = Commission - AI Cost - Server Cost - Other Cost
// for today / 7 days / this month / lifetime, plus per-product ranking.
const db = require('../config/db');

function getSetting(key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function sumCommission(sinceExpr) {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(commission),0) as total FROM performance_metrics
       WHERE date >= date('now', ?)`
    )
    .get(sinceExpr);
  return row.total;
}

function sumAiCost(sinceExpr) {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(estimated_cost),0) as total FROM ai_usage
       WHERE created_at >= datetime('now', ?)`
    )
    .get(sinceExpr);
  return row.total;
}

function sumOtherExpenses(sinceExpr, category) {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount),0) as total FROM expenses
       WHERE date >= datetime('now', ?) AND category = ?`
    )
    .get(sinceExpr, category);
  return row.total;
}

function proratedServerCost(days) {
  const monthly = parseFloat(getSetting('server_cost_monthly', '72000'));
  return (monthly / 30) * days;
}

function periodSnapshot(label, sinceExpr, days) {
  const commission = sumCommission(sinceExpr);
  const aiCost = sumAiCost(sinceExpr);
  const otherCost = sumOtherExpenses(sinceExpr, 'other');
  const serverCost = days === null ? parseFloat(getSetting('server_cost_monthly', '72000')) : proratedServerCost(days);
  const netProfit = commission - aiCost - serverCost - otherCost;

  return {
    label,
    grossCommission: +commission.toFixed(2),
    aiCost: +aiCost.toFixed(2),
    serverCost: +serverCost.toFixed(2),
    otherCost: +otherCost.toFixed(2),
    netProfit: +netProfit.toFixed(2),
  };
}

function calculateFinancials() {
  return {
    today: periodSnapshot('today', 'start of day', 1),
    last7Days: periodSnapshot('last_7_days', '-7 days', 7),
    thisMonth: periodSnapshot('this_month', 'start of month', 30),
    lifetime: periodSnapshot('lifetime', '-100 years', null),
  };
}

// Ranks products by real profit (commission minus direct AI cost
// attributed to that product's scripts/videos) - not just commission or
// views, per spec: "ranking produk berdasarkan profit, bukan hanya views."
function productRanking(limit = 20, filters = {}) {
  let query = `
    SELECT p.id, p.name, p.niche, p.status,
           COUNT(DISTINCT v.id) as total_videos,
           COALESCE(SUM(m.views),0) as total_views,
           COALESCE(SUM(m.clicks),0) as total_clicks,
           COALESCE(SUM(m.orders),0) as total_orders,
           COALESCE(SUM(m.commission),0) as commission,
           COALESCE((SELECT SUM(a.estimated_cost) FROM ai_usage a
                      WHERE a.video_id IN (SELECT id FROM videos WHERE product_id = p.id)
                         OR a.script_id IN (SELECT id FROM scripts WHERE product_id = p.id)), 0) as ai_cost
    FROM products p
    LEFT JOIN videos v ON v.product_id = p.id
    LEFT JOIN performance_metrics m ON m.video_id = v.id
    WHERE 1=1
  `;
  const params = [];
  if (filters.status) { query += ' AND p.status = ?'; params.push(filters.status); }
  if (filters.niche) { query += ' AND p.niche = ?'; params.push(filters.niche); }
  query += ' GROUP BY p.id ORDER BY (commission - ai_cost) DESC LIMIT ?';
  params.push(limit);

  return db
    .prepare(query)
    .all(...params)
    .map((r) => ({
      ...r,
      profit: +(r.commission - r.ai_cost).toFixed(2),
      conversion_rate: r.total_clicks ? +((r.total_orders / r.total_clicks) * 100).toFixed(2) : 0,
      avg_views_per_video: r.total_videos ? Math.round(r.total_views / r.total_videos) : 0,
    }));
}

module.exports = { calculateFinancials, productRanking, getSetting };
