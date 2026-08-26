// Initializes the SQLite database using schema.sql and seeds default rows
// (agents, settings) required for the app to function on first run.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, 'affiliate_factory.sqlite');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL'); // better concurrency on small VPS

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

const AGENTS = [
  ['product_hunter', 'Product Hunter'],
  ['trend_hunter', 'Trend Hunter'],
  ['script_writer', 'Script Writer'],
  ['content_agent', 'Content Agent'],
  ['critic_agent', 'Critic Agent'],
  ['money_agent', 'Money Agent'],
];

const insertAgent = db.prepare(
  `INSERT OR IGNORE INTO agents (name, display_name, status) VALUES (?, ?, 'idle')`
);
for (const [name, display] of AGENTS) insertAgent.run(name, display);

const DEFAULT_SETTINGS = {
  server_cost_monthly: process.env.DEFAULT_SERVER_COST_MONTHLY || '72000',
  other_cost_monthly: '0',
  max_video_concurrency: process.env.MAX_VIDEO_CONCURRENCY || '2',
  max_agent_concurrency: process.env.MAX_AGENT_CONCURRENCY || '3',
  max_product_price: '', // empty = no limit
  active_niche_focus: '',
};

const insertSetting = db.prepare(
  `INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`
);
for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) insertSetting.run(key, value);

console.log(`[db:init] Database ready at ${DB_PATH}`);
db.close();
