// Shared behaviour for every agent: status transitions, logging, and
// error handling. New agents extend this and only implement `run()`,
// which keeps the system modular - adding an agent never requires
// touching the other five.
const db = require('../config/db');
const logger = require('../utils/logger');
const { callAgentModel } = require('../services/router.service');

class BaseAgent {
  constructor(name, displayName) {
    this.name = name;
    this.displayName = displayName;
  }

  setStatus(status, currentTask = null) {
    db.prepare(
      `UPDATE agents SET status = ?, current_task = ?, updated_at = datetime('now') WHERE name = ?`
    ).run(status, currentTask, this.name);
  }

  markTaskDone(summary) {
    db.prepare(
      `UPDATE agents SET status = 'idle', current_task = NULL, last_task = ?, updated_at = datetime('now') WHERE name = ?`
    ).run(summary, this.name);
  }

  async think(messages, overrides = {}, context = {}) {
    return callAgentModel(this.name, messages, overrides, context);
  }

  log(level, message, meta) {
    logger.log(this.name, level, message, meta);
  }

  /**
   * Wraps run() with consistent status/logging/error handling.
   * Subclasses implement `run(input)` and return a plain result object.
   */
  async execute(taskType, input) {
    const row = db.prepare('SELECT status FROM agents WHERE name = ?').get(this.name);
    if (row && row.status === 'disabled') {
      this.log('warn', `Task rejected: agent is disabled`, { taskType });
      return { error: `Agent "${this.name}" is disabled. Enable it from the Agents page or use the "resume_agents" command.` };
    }

    this.setStatus('processing', taskType);
    this.log('info', `Started task: ${taskType}`, { input });

    const taskRow = db
      .prepare(`INSERT INTO tasks (agent_name, type, status, input, started_at) VALUES (?, ?, 'running', ?, datetime('now'))`)
      .run(this.name, taskType, JSON.stringify(input));

    try {
      const result = await this.run(taskType, input);
      db.prepare(
        `UPDATE tasks SET status = 'done', output = ?, finished_at = datetime('now') WHERE id = ?`
      ).run(JSON.stringify(result), taskRow.lastInsertRowid);
      this.markTaskDone(taskType);
      this.log('info', `Finished task: ${taskType}`);
      return result;
    } catch (err) {
      // Distinguish "integration not configured" (expected, operator-actionable)
      // from a genuine failure (bug/timeout/provider error) so the UI and
      // agent status don't cry "error" for something that's just unset config.
      const isNotConfigured = err.code === 'NOT_CONFIGURED' || /NOT_CONFIGURED/.test(err.message || '');
      const taskStatus = isNotConfigured ? 'not_configured' : 'failed';
      const agentStatus = isNotConfigured ? 'idle' : 'error';

      db.prepare(
        `UPDATE tasks SET status = ?, error = ?, finished_at = datetime('now') WHERE id = ?`
      ).run(taskStatus, err.message, taskRow.lastInsertRowid);
      db.prepare(`UPDATE agents SET status = ?, current_task = NULL WHERE name = ?`).run(agentStatus, this.name);
      this.log(isNotConfigured ? 'warn' : 'error', `Task ${taskStatus}: ${taskType}`, {
        error: err.message,
        provider: err.provider,
        modelsTried: err.modelsTried,
      });
      // Never throw further up in a way that could crash the server process.
      return { error: err.message, status: taskStatus, provider: err.provider, modelsTried: err.modelsTried };
    }
  }

  // eslint-disable-next-line no-unused-vars
  async run(taskType, input) {
    throw new Error(`${this.name}.run() not implemented`);
  }
}

module.exports = BaseAgent;
