// Runs the full product -> trend -> script -> critic -> video -> critic
// pipeline end-to-end for the Command Center's "create N videos" action.
// Every step goes through the same agent queue as manual calls, so
// concurrency limits and resource throttling apply here too.
const db = require('../config/db');
const logger = require('../utils/logger');
const { agentQueue } = require('./queue.service');

const TrendHunterAgent = require('../agents/trendHunter.agent');
const ScriptWriterAgent = require('../agents/scriptWriter.agent');
const ContentAgent = require('../agents/contentAgent');
const CriticAgent = require('../agents/criticAgent');

const trendHunter = new TrendHunterAgent();
const scriptWriter = new ScriptWriterAgent();
const contentAgent = new ContentAgent();
const criticAgent = new CriticAgent();

function pickTopProduct(excludeIds = []) {
  const placeholders = excludeIds.length ? excludeIds.map(() => '?').join(',') : null;
  const query = placeholders
    ? `SELECT * FROM products WHERE status != 'rejected' AND id NOT IN (${placeholders}) ORDER BY score DESC LIMIT 1`
    : `SELECT * FROM products WHERE status != 'rejected' ORDER BY score DESC LIMIT 1`;
  return placeholders ? db.prepare(query).get(...excludeIds) : db.prepare(query).get();
}

async function runOneVideoForProduct(productId, platform = 'tiktok', inspirationHook = null) {
  const trends = await agentQueue.push(() => trendHunter.execute('hunt_trends', { productId }));
  if (trends.error) return { productId, error: trends.error, stage: 'trend_hunter' };

  const topAngle = inspirationHook
    ? { angle: 'variation_of_winning_video', hook_idea: inspirationHook, why_it_works: 'Video sebelumnya dengan hook ini terbukti profitable' }
    : trends.angles?.[0];

  const scripts = await agentQueue.push(() =>
    scriptWriter.execute('write_scripts', {
      productId,
      angle: topAngle,
      angleDataSource: inspirationHook ? 'winning_video_variation' : trends.dataSource,
      variantCount: 3,
    })
  );
  if (scripts.error) return { productId, error: scripts.error, stage: 'script_writer' };

  // Critique every variant, use the first one that passes.
  let approvedScript = null;
  for (const s of scripts.scripts || []) {
    const critique = await agentQueue.push(() => criticAgent.execute('critique_script', { scriptId: s.id }));
    if (critique.status === 'approved') {
      approvedScript = { ...s, ...critique };
      break;
    }
  }

  if (!approvedScript) {
    return { productId, error: 'No script variant passed critic review', stage: 'critic_agent' };
  }

  const videoResult = await contentAgent.execute('generate_video', { scriptId: approvedScript.id, platform });
  if (videoResult.error) return { productId, error: videoResult.error, stage: 'content_agent' };

  const critique = await agentQueue.push(() => criticAgent.execute('critique_video', { videoId: videoResult.videoId }));

  return { productId, videoId: videoResult.videoId, scriptId: approvedScript.id, status: critique.status };
}

/**
 * Runs the pipeline `count` times. If `productId` is given, reuses that
 * product for every video; otherwise picks the top-scoring product each
 * time (allowing repeats since "10 videos for this week's best product"
 * commonly means the SAME best product, several angles).
 * @param {function} [onProgress] - called after each video with (current, total, lastResult)
 */
async function runFullPipeline({ productId, count = 1, platform = 'tiktok', onProgress } = {}) {
  const results = [];

  for (let i = 0; i < count; i++) {
    let targetProductId = productId;
    if (!targetProductId) {
      const product = pickTopProduct();
      if (!product) {
        results.push({ error: 'No eligible product found' });
        break;
      }
      targetProductId = product.id;
    }

    logger.log('money_agent', 'info', `Pipeline run ${i + 1}/${count} for product ${targetProductId}`);
    // eslint-disable-next-line no-await-in-loop
    const result = await runOneVideoForProduct(targetProductId, platform);
    results.push(result);
    if (onProgress) onProgress(i + 1, count, result);
  }

  return { requested: count, completed: results.length, results };
}

/**
 * "Buat variasi dari video terbaik" - finds the highest-profit video to
 * date, and produces `count` new videos for the SAME product, explicitly
 * inspired by that winning video's hook. This is what makes Money
 * Agent's learning loop actionable rather than just advisory.
 */
async function runVariationOfBest({ count = 3, platform = 'tiktok', onProgress } = {}) {
  const best = db
    .prepare(
      `SELECT v.id, v.product_id, s.hook,
              COALESCE(SUM(m.commission),0) -
              (COALESCE((SELECT SUM(a1.estimated_cost) FROM ai_usage a1 WHERE a1.video_id = v.id), 0) +
               COALESCE((SELECT SUM(a2.estimated_cost) FROM ai_usage a2 WHERE a2.script_id = v.script_id), 0)) as profit
       FROM videos v
       LEFT JOIN performance_metrics m ON m.video_id = v.id
       LEFT JOIN scripts s ON s.id = v.script_id
       WHERE v.status IN ('published', 'ready_to_publish')
       GROUP BY v.id
       ORDER BY profit DESC
       LIMIT 1`
    )
    .get();

  if (!best) {
    return { error: 'Belum ada video published/ready_to_publish untuk dijadikan referensi variasi.' };
  }

  const results = [];
  for (let i = 0; i < count; i++) {
    logger.log('money_agent', 'info', `Variation run ${i + 1}/${count} inspired by video ${best.id}`);
    // eslint-disable-next-line no-await-in-loop
    const result = await runOneVideoForProduct(best.product_id, platform, best.hook);
    results.push(result);
    if (onProgress) onProgress(i + 1, count, result);
  }

  return { basedOnVideoId: best.id, basedOnHook: best.hook, requested: count, completed: results.length, results };
}

module.exports = { runFullPipeline, runVariationOfBest };
