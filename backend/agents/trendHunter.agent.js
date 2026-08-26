// Trend Hunter - finds ideas, angles, hooks and content patterns, then
// connects them to a chosen product.
//
// HONESTY RULE: if no real trend/research provider is configured, the
// angles produced are AI brainstorming, not real-time trend data. Every
// output is tagged with data_source so downstream consumers (dashboard,
// Script Writer, the person reading the DB) never mistake a heuristic
// suggestion for verified trend intelligence.
const BaseAgent = require('./baseAgent');
const db = require('../config/db');
const { fetchTrendContext } = require('../services/adapters/trendData.adapter');

class TrendHunterAgent extends BaseAgent {
  constructor() {
    super('trend_hunter', 'Trend Hunter');
  }

  async run(taskType, input) {
    if (taskType !== 'hunt_trends') throw new Error(`Unsupported task type: ${taskType}`);

    const { productId } = input || {};
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
    if (!product) throw new Error(`Product ${productId} not found`);

    const trendResult = await fetchTrendContext({ niche: product.niche, productName: product.name });
    const dataSource = trendResult.configured && trendResult.context ? 'live_trend_api' : 'ai_generated_heuristic';

    const recentAngles = db
      .prepare(
        `SELECT message FROM agent_logs WHERE agent_name = 'trend_hunter' AND level = 'info' ORDER BY created_at DESC LIMIT 20`
      )
      .all()
      .map((r) => r.message);

    const systemPrompt =
      dataSource === 'live_trend_api'
        ? 'You are the Trend Hunter agent. You are given REAL trend/research data for this product/niche. ' +
          'Propose 3-5 distinct content angles/hooks grounded in that real data. Avoid generic or repeated angles.'
        : 'You are the Trend Hunter agent. No real-time trend data source is configured, so propose 3-5 ' +
          'plausible content angles/hooks based on general knowledge of what tends to work for this kind of ' +
          'product. Do NOT claim these reflect real-time trends - they are creative suggestions only. Avoid ' +
          'generic or repeated angles.';

    const prompt = [
      {
        role: 'system',
        content:
          systemPrompt +
          ' Respond ONLY as a JSON array of objects: { angle, hook_idea, why_it_works }.',
      },
      {
        role: 'user',
        content: JSON.stringify({ product, trendContext: trendResult.context, recentAngles }),
      },
    ];

    const raw = await this.think(prompt);
    let angles;
    try {
      angles = JSON.parse(raw);
    } catch (err) {
      throw new Error('Trend Hunter returned non-JSON output');
    }

    for (const a of angles) {
      this.log('info', `Angle [${dataSource}]: ${a.angle}`, { productId, hook_idea: a.hook_idea });
    }

    return { productId, angles, dataSource };
  }
}

module.exports = TrendHunterAgent;
