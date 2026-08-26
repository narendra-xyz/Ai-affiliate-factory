// Money Agent - the analytics brain. Reads real performance data (views,
// clicks, orders, conversion, commission, profit), finds patterns, and
// recommends what to make next. Explicitly does NOT treat high views as
// a proxy for profit.
const BaseAgent = require('./baseAgent');
const db = require('../config/db');
const { calculateFinancials } = require('../services/financeCalculator.service');

class MoneyAgent extends BaseAgent {
  constructor() {
    super('money_agent', 'Money Agent');
  }

  async run(taskType, input) {
    if (taskType === 'recommend_next') return this.recommendNext(input);
    if (taskType === 'analyze_failures') return this.analyzeFailures(input);
    if (taskType === 'analyze_low_performers') return this.analyzeLowPerformers(input);
    throw new Error(`Unsupported task type: ${taskType}`);
  }

  async recommendNext({ range = '30d' } = {}) {
    const rows = db
      .prepare(
        `SELECT v.id as video_id, v.title, v.platform, p.name as product_name, p.id as product_id,
                SUM(m.views) as views, SUM(m.clicks) as clicks, SUM(m.orders) as orders,
                SUM(m.commission) as commission,
                COALESCE((SELECT SUM(a1.estimated_cost) FROM ai_usage a1 WHERE a1.video_id = v.id), 0) +
                COALESCE((SELECT SUM(a2.estimated_cost) FROM ai_usage a2 WHERE a2.script_id = v.script_id), 0) as ai_cost
         FROM videos v
         LEFT JOIN performance_metrics m ON m.video_id = v.id
         LEFT JOIN products p ON p.id = v.product_id
         WHERE v.created_at >= datetime('now', ?)
         GROUP BY v.id
         ORDER BY (commission - ai_cost) DESC`
      )
      .all(`-${range === '30d' ? 30 : 7} days`);

    const enriched = rows.map((r) => ({
      ...r,
      profit: +(r.commission - r.ai_cost).toFixed(2),
      conversion_rate: r.clicks ? +((r.orders / r.clicks) * 100).toFixed(2) : 0,
      is_high_traffic_low_conversion: r.views > 1000 && r.orders === 0,
    }));

    // Feed previously learned patterns/warnings back into the prompt so
    // the model doesn't have to re-discover (or contradict) what it
    // already learned from earlier analyses.
    const pastInsights = db
      .prepare(`SELECT category, insight_text FROM learned_insights ORDER BY created_at DESC LIMIT 15`)
      .all();

    const prompt = [
      {
        role: 'system',
        content:
          'You are the Money Agent. Analyze this real performance data and recommend what content to ' +
          'produce next. Do NOT assume high views mean high profit - flag videos that got traffic but ' +
          'no orders as a conversion problem, not a success. Identify winning formats/products worth ' +
          'making variations of. You are given previously learned patterns/warnings from past analyses - ' +
          'do not repeat a warning that has already been acted on, and build on winning patterns rather ' +
          'than rediscovering them from scratch. Respond ONLY as JSON: { recommendations: [ { action, reason } ], ' +
          'winning_patterns: [string], warnings: [string] }.',
      },
      { role: 'user', content: JSON.stringify({ performanceData: enriched, pastInsights }) },
    ];

    const raw = await this.think(prompt);
    const analysis = JSON.parse(raw);

    // Persist newly surfaced patterns/warnings for next time.
    const insertInsight = db.prepare(
      `INSERT INTO learned_insights (category, insight_text) VALUES (?, ?)`
    );
    for (const p of analysis.winning_patterns || []) insertInsight.run('winning_pattern', p);
    for (const w of analysis.warnings || []) insertInsight.run('warning', w);

    this.log('info', `Generated ${analysis.recommendations?.length || 0} recommendations`, analysis);
    return { data: enriched, ...analysis };
  }

  // Distinct from analyzeFailures: this looks at videos that rendered and
  // PUBLISHED fine (no technical failure) but performed poorly - high
  // views/low conversion, or low views entirely - which is a content/
  // targeting problem, not a pipeline error.
  async analyzeLowPerformers({ range = '30d', minViewsForConsideration = 50 } = {}) {
    const rows = db
      .prepare(
        `SELECT v.id as video_id, v.title, v.platform, p.name as product_name, s.hook, s.angle_data_source,
                SUM(m.views) as views, SUM(m.clicks) as clicks, SUM(m.orders) as orders, SUM(m.commission) as commission
         FROM videos v
         LEFT JOIN performance_metrics m ON m.video_id = v.id
         LEFT JOIN products p ON p.id = v.product_id
         LEFT JOIN scripts s ON s.id = v.script_id
         WHERE v.status IN ('published', 'ready_to_publish') AND v.created_at >= datetime('now', ?)
         GROUP BY v.id
         HAVING views >= ? AND (orders = 0 OR (clicks > 0 AND (orders * 1.0 / clicks) < 0.01))
         ORDER BY views DESC`
      )
      .all(`-${range === '30d' ? 30 : 7} days`, minViewsForConsideration);

    if (rows.length === 0) {
      return { message: 'Tidak ada video published dengan performa buruk pada periode ini.', lowPerformers: [] };
    }

    const prompt = [
      {
        role: 'system',
        content:
          'You are the Money Agent. These videos got real traffic but converted poorly (low/no orders relative ' +
          'to views/clicks) despite publishing successfully - this is a content/targeting problem, not a ' +
          'technical failure. Identify likely reasons (weak CTA, mismatched product-audience fit, wrong hook, ' +
          'wrong platform, etc) and concrete fixes. Respond ONLY as JSON: { summary, likely_causes: [string], fixes: [string] }.',
      },
      { role: 'user', content: JSON.stringify(rows) },
    ];

    const raw = await this.think(prompt);
    const analysis = JSON.parse(raw);

    const insertInsight = db.prepare(`INSERT INTO learned_insights (category, insight_text) VALUES ('warning', ?)`);
    for (const cause of analysis.likely_causes || []) insertInsight.run(cause);

    return { lowPerformers: rows, ...analysis };
  }

  async analyzeFailures({ days = 3 } = {}) {
    const failed = db
      .prepare(
        `SELECT v.*, s.hook, s.body FROM videos v
         LEFT JOIN scripts s ON s.id = v.script_id
         WHERE v.status = 'failed' AND v.created_at >= datetime('now', ?)`
      )
      .all(`-${days} days`);

    if (failed.length === 0) return { message: 'No failed videos in this period.', failed: [] };

    const prompt = [
      {
        role: 'system',
        content:
          'You are the Money Agent. Given these failed videos (with their fail reasons and scripts), ' +
          'summarize the likely root causes and concrete fixes. Respond ONLY as JSON: ' +
          '{ summary, root_causes: [string], fixes: [string] }.',
      },
      { role: 'user', content: JSON.stringify(failed) },
    ];

    const raw = await this.think(prompt);
    const analysis = JSON.parse(raw);

    const insertInsight = db.prepare(`INSERT INTO learned_insights (category, insight_text) VALUES ('warning', ?)`);
    for (const cause of analysis.root_causes || []) insertInsight.run(cause);

    return { failed, ...analysis };
  }

  async financialSnapshot() {
    return calculateFinancials();
  }
}

module.exports = MoneyAgent;
