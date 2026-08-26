// 9Router client - the ONLY place that talks to AI providers.
// Provider-agnostic by design, and cost-conscious by design: each agent
// has an ORDERED pool of free-tier models. The router always tries free
// models first, and only touches a paid model if the agent's
// `allow_paid_fallback` is explicitly true AND every free model in its
// pool is currently limited/exhausted. Rate-limit/quota failures on a
// model mark it "limited" for a cooldown window so subsequent calls skip
// straight to the next free model instead of re-hitting a dead one.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('../config/db');
const logger = require('../utils/logger');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'agents.config.json');
const DEFAULT_COOLDOWN_MINUTES = parseInt(process.env.MODEL_COOLDOWN_MINUTES || '30', 10);

function loadFileConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function loadAgentConfig(agentName) {
  const fileConfig = loadFileConfig();
  const base = fileConfig[agentName] || {};

  // Model pool comes from the environment, never hardcoded here - e.g.
  // NINEROUTER_MODELS_SCRIPT_WRITER="modelA:free:200,modelB:free:200,modelC:paid"
  // Format per entry: id[:tier][:daily_limit]  (tier defaults to 'free')
  const envKey = `NINEROUTER_MODELS_${agentName.toUpperCase()}`;
  const envValue = process.env[envKey];
  const envModels = envValue
    ? envValue.split(',').map((entry) => {
        const [id, tier, dailyLimit] = entry.split(':').map((s) => (s || '').trim());
        return { id, tier: tier === 'paid' ? 'paid' : 'free', daily_limit: dailyLimit ? parseInt(dailyLimit, 10) : null };
      }).filter((m) => m.id)
    : [];

  // Runtime override stored in DB (set from dashboard Settings page) wins
  // over the environment, so models/order can change without a restart.
  const row = db.prepare('SELECT model_config FROM agents WHERE name = ?').get(agentName);
  let dbOverride = null;
  if (row && row.model_config) {
    try {
      dbOverride = JSON.parse(row.model_config);
    } catch (_) {
      dbOverride = null;
    }
  }

  return {
    ...base,
    ...(dbOverride || {}),
    models: (dbOverride && dbOverride.models) || envModels,
  };
}

function isAgentConfigured(agentName) {
  return loadAgentConfig(agentName).models.length > 0;
}

function isModelLimited(agentName, modelId) {
  const row = db
    .prepare('SELECT * FROM agent_model_status WHERE agent_name = ? AND model_id = ?')
    .get(agentName, modelId);
  if (!row || row.status !== 'limited') return false;
  if (row.limited_until && new Date(row.limited_until) <= new Date()) {
    // cooldown expired, model is usable again
    db.prepare(`UPDATE agent_model_status SET status = 'available' WHERE agent_name = ? AND model_id = ?`).run(
      agentName,
      modelId
    );
    return false;
  }
  return true;
}

function markModelLimited(agentName, modelId, reason, cooldownMinutes = DEFAULT_COOLDOWN_MINUTES) {
  const limitedUntil = new Date(Date.now() + cooldownMinutes * 60 * 1000).toISOString();
  db.prepare(
    `INSERT INTO agent_model_status (agent_name, model_id, status, limited_until, last_error, updated_at)
     VALUES (?, ?, 'limited', ?, ?, datetime('now'))
     ON CONFLICT(agent_name, model_id) DO UPDATE SET
       status = 'limited', limited_until = excluded.limited_until,
       last_error = excluded.last_error, updated_at = datetime('now')`
  ).run(agentName, modelId, limitedUntil, reason);
}

function dailyUsageCount(agentName, modelId) {
  const row = db
    .prepare(
      `SELECT COUNT(*) as n FROM ai_usage
       WHERE agent_name = ? AND model = ? AND date(created_at) = date('now')`
    )
    .get(agentName, modelId);
  return row.n;
}

// Returns the ordered list of models still eligible to try right now:
// free models that aren't limited and haven't hit their daily_limit, then
// (only if allowed and nothing free is left) paid models.
function eligibleModels(agentName, cfg) {
  const pool = cfg.models || [];
  const free = pool.filter((m) => m.tier === 'free');
  const paid = pool.filter((m) => m.tier === 'paid');

  const usableFree = free.filter((m) => {
    if (isModelLimited(agentName, m.id)) return false;
    if (m.daily_limit && dailyUsageCount(agentName, m.id) >= m.daily_limit) return false;
    return true;
  });

  if (usableFree.length > 0) return usableFree;

  if (cfg.allow_paid_fallback) {
    const usablePaid = paid.filter((m) => !isModelLimited(agentName, m.id));
    if (usablePaid.length > 0) {
      logger.log(agentName, 'warn', 'All free models exhausted - falling back to paid model (allow_paid_fallback=true)');
      return usablePaid;
    }
  }

  return []; // nothing usable at all
}

function looksLikeRateLimit(status, message) {
  if (status === 429) return true;
  const m = (message || '').toLowerCase();
  return m.includes('rate limit') || m.includes('quota') || m.includes('too many requests') || m.includes('limit exceeded');
}

/**
 * Calls 9Router's chat/completions-style endpoint for a given agent,
 * automatically walking the agent's free-model pool on failure.
 * @param {string} agentName
 * @param {Array<{role:string, content:string}>} messages
 * @param {object} [overrides]
 */
async function callAgentModel(agentName, messages, overrides = {}, context = {}) {
  const cfg = { ...loadAgentConfig(agentName), ...overrides };
  const baseUrl = process.env.NINEROUTER_BASE_URL;
  const apiKey = process.env.NINEROUTER_API_KEY;

  if (!baseUrl || !apiKey) {
    const err = new Error(
      `NOT_CONFIGURED: 9Router gateway belum dikonfigurasi. Set NINEROUTER_BASE_URL dan NINEROUTER_API_KEY di .env.`
    );
    err.code = 'NOT_CONFIGURED';
    throw err;
  }

  const candidates = overrides.model
    ? [{ id: overrides.model, tier: 'free' }] // explicit override bypasses pool selection
    : eligibleModels(agentName, cfg);

  if (candidates.length === 0) {
    const hasAnyModelInPool = (cfg.models || []).length > 0;
    const msg = hasAnyModelInPool
      ? `Semua model gratis untuk "${agentName}" sedang limit/exhausted, dan paid fallback tidak diaktifkan atau juga habis.`
      : `NOT_CONFIGURED: Agent "${agentName}" belum punya model. Set env var NINEROUTER_MODELS_${agentName.toUpperCase()} (contoh: "model-id-1:free:200,model-id-2:free:200").`;
    const err = new Error(msg);
    err.code = hasAnyModelInPool ? 'ALL_MODELS_LIMITED' : 'NOT_CONFIGURED';
    logger.log(agentName, 'error', msg);
    throw err;
  }

  let lastError;

  for (const candidate of candidates) {
    const body = {
      model: candidate.id,
      messages,
      temperature: cfg.temperature ?? 0.5,
      max_tokens: cfg.max_tokens ?? 1000,
    };

    const MAX_RETRIES_PER_MODEL = 1; // brief retry on transient errors before moving to next model
    for (let attempt = 0; attempt <= MAX_RETRIES_PER_MODEL; attempt++) {
      try {
        const res = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const text = await res.text();
          if (looksLikeRateLimit(res.status, text)) {
            markModelLimited(agentName, candidate.id, `HTTP ${res.status}: ${text}`.slice(0, 300));
            logger.log(agentName, 'warn', `Model "${candidate.id}" is rate-limited/exhausted, switching to next free model`, {
              status: res.status,
            });
            break; // stop retrying this model, go to next candidate
          }
          throw new Error(`9Router responded ${res.status}: ${text}`);
        }

        const data = await res.json();
        const usage = data.usage || {};

        db.prepare(
          `INSERT INTO ai_usage (agent_name, provider, model, script_id, video_id, input_tokens, output_tokens, estimated_cost)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          agentName,
          '9router',
          candidate.id,
          context.scriptId || null,
          context.videoId || null,
          usage.prompt_tokens || 0,
          usage.completion_tokens || 0,
          usage.estimated_cost || 0
        );

        return data.choices?.[0]?.message?.content ?? '';
      } catch (err) {
        lastError = err;
        logger.log(agentName, 'warn', `Call to model "${candidate.id}" failed (attempt ${attempt + 1})`, { error: err.message });
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      }
    }
    // loop continues to next candidate model
  }

  logger.log(agentName, 'error', 'All candidate models exhausted for this call', {
    error: lastError?.message,
    modelsTried: candidates.map((c) => c.id),
  });
  const finalErr = lastError || new Error('All candidate models failed');
  finalErr.provider = '9router';
  finalErr.modelsTried = candidates.map((c) => c.id);
  finalErr.message = `Gagal memanggil 9Router untuk agent "${agentName}" (model dicoba: ${candidates.map((c) => c.id).join(', ')}). Alasan: ${finalErr.message}`;
  throw finalErr;
}

module.exports = { callAgentModel, loadAgentConfig, eligibleModels, isAgentConfigured };
