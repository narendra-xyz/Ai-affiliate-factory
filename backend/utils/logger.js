// Central logger: writes agent activity to the agent_logs table so the
// dashboard can show "what the AI is doing" without opening a terminal.
const db = require('../config/db');

function log(agentName, level, message, meta = {}) {
  try {
    db.prepare(
      `INSERT INTO agent_logs (agent_name, level, message, meta) VALUES (?, ?, ?, ?)`
    ).run(agentName, level, message, JSON.stringify(meta));
  } catch (err) {
    // Logging must never crash the app.
    console.error('[logger] failed to write log:', err.message);
  }
  const stamp = new Date().toISOString();
  console.log(`[${stamp}] [${agentName}] [${level}] ${message}`);
}

module.exports = { log };
