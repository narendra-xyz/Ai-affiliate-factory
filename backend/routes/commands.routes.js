// Command Center endpoint. Parses natural language into a whitelisted
// action (see commandParser.service.js) and dispatches it - never runs
// raw shell/code from user text.
const express = require('express');
const { z } = require('zod');
const db = require('../config/db');
const { validateBody } = require('../middleware/validate.middleware');
const { commandLimiter } = require('../middleware/rateLimit.middleware');
const { parseCommand } = require('../services/commandParser.service');
const { agentQueue } = require('../services/queue.service');

const ProductHunterAgent = require('../agents/productHunter.agent');
const MoneyAgent = require('../agents/moneyAgent');
const { calculateFinancials } = require('../services/financeCalculator.service');
const { runFullPipeline, runVariationOfBest } = require('../services/pipelineOrchestrator.service');
const logger = require('../utils/logger');

const router = express.Router();
const productHunter = new ProductHunterAgent();
const moneyAgent = new MoneyAgent();

const commandSchema = z.object({ text: z.string().min(1).max(500) });

// Actions that run a multi-step background pipeline instead of completing
// within the HTTP request. For these, dispatch() returns immediately with
// { async: true } and the command row is kept at status 'executing' with
// live progress_current/progress_total, only flipping to 'done'/'failed'
// once the actual background work finishes - never marked done early.
const ASYNC_ACTIONS = new Set(['create_videos', 'create_variation_of_best']);

function runAsyncPipeline(commandId, pipelinePromiseFactory) {
  const onProgress = (current, total) => {
    db.prepare(`UPDATE commands SET progress_current = ?, progress_total = ? WHERE id = ?`).run(current, total, commandId);
  };

  pipelinePromiseFactory(onProgress)
    .then((result) => {
      db.prepare(`UPDATE commands SET status = 'done', result = ? WHERE id = ?`).run(JSON.stringify(result), commandId);
      logger.log('money_agent', 'info', `Async command ${commandId} finished`, result);
    })
    .catch((err) => {
      db.prepare(`UPDATE commands SET status = 'failed', result = ? WHERE id = ?`).run(err.message, commandId);
      logger.log('money_agent', 'error', `Async command ${commandId} failed`, { error: err.message });
    });
}

async function dispatch(action, params, commandId) {
  switch (action) {
    case 'find_products':
      return agentQueue.push(() => productHunter.execute('hunt_products', params));
    case 'set_niche_focus':
      db.prepare(`INSERT INTO settings (key, value) VALUES ('active_niche_focus', ?)
                  ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(params.niche);
      return { niche: params.niche, applied: true };
    case 'analyze_failures':
      return agentQueue.push(() => moneyAgent.execute('analyze_failures', params));
    case 'analyze_low_performers':
      return agentQueue.push(() => moneyAgent.execute('analyze_low_performers', params));
    case 'create_variation_of_best': {
      const count = Math.min(params.count || 3, 10);
      db.prepare(`UPDATE commands SET progress_total = ? WHERE id = ?`).run(count, commandId);
      runAsyncPipeline(commandId, (onProgress) => runVariationOfBest({ count, onProgress }));
      return { async: true, requestedCount: count, note: 'Membuat variasi dari video terbaik - pantau progress di riwayat command ini.' };
    }
    case 'replicate_best_format':
      return agentQueue.push(() => moneyAgent.execute('recommend_next', { range: '30d' }));
    case 'stop_all_agents':
      db.prepare(`UPDATE agents SET status = 'disabled'`).run();
      return { allAgentsDisabled: true };
    case 'resume_agents':
      db.prepare(`UPDATE agents SET status = 'idle'`).run();
      return { allAgentsResumed: true };
    case 'show_profit':
      return calculateFinancials()[params.range] || calculateFinancials();
    case 'set_max_product_price':
      db.prepare(`INSERT INTO settings (key, value) VALUES ('max_product_price', ?)
                  ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(params.maxPrice));
      return { maxPrice: params.maxPrice, applied: true };
    case 'create_videos': {
      const count = Math.min(params.count || 1, 20); // hard cap to avoid runaway cost
      db.prepare(`UPDATE commands SET progress_total = ? WHERE id = ?`).run(count, commandId);
      runAsyncPipeline(commandId, (onProgress) => runFullPipeline({ productId: params.productId, count, onProgress }));
      return { async: true, requestedCount: count, note: 'Pipeline berjalan di background - pantau progress di riwayat command ini.' };
    }
    default:
      return { error: 'Unknown or unsupported action' };
  }
}

router.post('/', commandLimiter, validateBody(commandSchema), async (req, res) => {
  const parsed = await parseCommand(req.body.text);

  if (parsed.rejected || !parsed.action) {
    db.prepare(`UPDATE commands SET status = 'rejected' WHERE id = ?`).run(parsed.commandId);
    return res.status(400).json({ error: 'Command not understood or not permitted', commandId: parsed.commandId });
  }

  db.prepare(`UPDATE commands SET status = 'executing' WHERE id = ?`).run(parsed.commandId);

  try {
    const result = await dispatch(parsed.action, parsed.params, parsed.commandId);

    // Async actions manage their own final status/result once the
    // background pipeline completes - don't mark 'done' here.
    if (!ASYNC_ACTIONS.has(parsed.action)) {
      db.prepare(`UPDATE commands SET status = 'done', result = ? WHERE id = ?`).run(
        JSON.stringify(result),
        parsed.commandId
      );
    }

    res.json({ commandId: parsed.commandId, action: parsed.action, result });
  } catch (err) {
    db.prepare(`UPDATE commands SET status = 'failed', result = ? WHERE id = ?`).run(err.message, parsed.commandId);
    res.status(500).json({ error: err.message, commandId: parsed.commandId });
  }
});

router.get('/history', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '30', 10), 100);
  res.json(db.prepare('SELECT * FROM commands ORDER BY created_at DESC LIMIT ?').all(limit));
});

// Single command status - used for polling progress of async commands.
router.get('/:id', (req, res) => {
  const command = db.prepare('SELECT * FROM commands WHERE id = ?').get(req.params.id);
  if (!command) return res.status(404).json({ error: 'Command not found' });
  res.json(command);
});

module.exports = router;
