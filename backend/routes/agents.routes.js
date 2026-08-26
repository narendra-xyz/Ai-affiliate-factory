const express = require('express');
const fs = require('fs');
const path = require('path');
const { z } = require('zod');
const db = require('../config/db');
const { validateBody } = require('../middleware/validate.middleware');
const { loadAgentConfig } = require('../services/router.service');

const router = express.Router();
const CONFIG_PATH = path.join(__dirname, '..', 'config', 'agents.config.json');

router.get('/', (req, res) => {
  res.json(db.prepare('SELECT * FROM agents ORDER BY name').all());
});

router.get('/:name/logs', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
  res.json(
    db
      .prepare('SELECT * FROM agent_logs WHERE agent_name = ? ORDER BY created_at DESC LIMIT ?')
      .all(req.params.name, limit)
  );
});

// Task history for an agent (id, type, status, timestamps, error) - what
// backs "melihat task aktif / task terakhir / error" per agent, using
// real task rows rather than only the single current_task/last_task
// summary fields on the agents table.
router.get('/:name/tasks', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '30', 10), 100);
  res.json(
    db
      .prepare('SELECT id, type, status, error, created_at, started_at, finished_at FROM tasks WHERE agent_name = ? ORDER BY created_at DESC LIMIT ?')
      .all(req.params.name, limit)
  );
});

// Generic retry for ANY failed task, not just video generation. Re-runs
// the same agent.execute(type, input) using the task's original input.
router.post('/tasks/:taskId/retry', async (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.taskId);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (task.status !== 'failed' && task.status !== 'not_configured') {
    return res.status(400).json({ error: 'Only failed or not_configured tasks can be retried' });
  }

  const agentMap = {
    product_hunter: () => new (require('../agents/productHunter.agent'))(),
    trend_hunter: () => new (require('../agents/trendHunter.agent'))(),
    script_writer: () => new (require('../agents/scriptWriter.agent'))(),
    content_agent: () => new (require('../agents/contentAgent'))(),
    critic_agent: () => new (require('../agents/criticAgent'))(),
    money_agent: () => new (require('../agents/moneyAgent'))(),
  };

  const factory = agentMap[task.agent_name];
  if (!factory) return res.status(400).json({ error: `Unknown agent "${task.agent_name}", cannot retry` });

  let input = {};
  try { input = JSON.parse(task.input || '{}'); } catch (_) { /* leave as {} */ }

  const agent = factory();
  const result = await agent.execute(task.type, input);
  res.json(result);
});

router.get('/logs/recent', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '100', 10), 300);
  res.json(db.prepare('SELECT * FROM agent_logs ORDER BY created_at DESC LIMIT ?').all(limit));
});

// Patterns/warnings the Money Agent has learned from past performance
// analyses - what "Learning System" persists so the same mistake isn't
// re-analyzed from scratch every time.
router.get('/insights', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '30', 10), 100);
  res.json(db.prepare('SELECT * FROM learned_insights ORDER BY created_at DESC LIMIT ?').all(limit));
});

// Enable/disable an agent (used by "Hentikan semua agent" command and by
// the dashboard toggle). Disabled agents refuse new tasks.
const agentStatusSchema = z.object({ status: z.enum(['active', 'idle', 'disabled']) });

router.patch('/:name/status', validateBody(agentStatusSchema), (req, res) => {
  db.prepare(`UPDATE agents SET status = ?, updated_at = datetime('now') WHERE name = ?`).run(
    req.body.status,
    req.params.name
  );
  res.json({ ok: true });
});

// Returns the effective model config for an agent (file config + any
// dashboard override merged), plus live limited/available status for
// each model in its pool - this is what the Settings page renders.
router.get('/:name/model-config', (req, res) => {
  const cfg = loadAgentConfig(req.params.name);
  const statusRows = db
    .prepare('SELECT model_id, status, limited_until FROM agent_model_status WHERE agent_name = ?')
    .all(req.params.name);
  const statusMap = Object.fromEntries(statusRows.map((r) => [r.model_id, r]));

  const models = (cfg.models || []).map((m) => ({
    ...m,
    live_status: statusMap[m.id]?.status || 'available',
    limited_until: statusMap[m.id]?.limited_until || null,
  }));

  res.json({ ...cfg, models });
});

const modelConfigSchema = z.object({
  allow_paid_fallback: z.boolean().optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().optional(),
  models: z
    .array(
      z.object({
        id: z.string().min(1),
        tier: z.enum(['free', 'paid']),
        daily_limit: z.number().int().positive().nullable().optional(),
      })
    )
    .optional(),
});

// Update per-agent model config from the dashboard (no code change needed).
// Stored as a DB override so it survives without editing agents.config.json.
router.patch('/:name/model-config', validateBody(modelConfigSchema), (req, res) => {
  db.prepare(`UPDATE agents SET model_config = ?, updated_at = datetime('now') WHERE name = ?`).run(
    JSON.stringify(req.body),
    req.params.name
  );
  res.json({ ok: true });
});

// Manually clear a model's "limited" status (e.g. operator knows the
// provider's quota reset early, or wants to force-retry).
router.post('/:name/model-config/:modelId/reset-limit', (req, res) => {
  db.prepare(
    `UPDATE agent_model_status SET status = 'available', limited_until = NULL WHERE agent_name = ? AND model_id = ?`
  ).run(req.params.name, req.params.modelId);
  res.json({ ok: true });
});

router.get('/model-catalog/defaults', (req, res) => {
  res.json(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
});

module.exports = router;
