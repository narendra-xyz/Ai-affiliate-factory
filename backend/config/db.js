// Shared SQLite connection (single connection is fine for a small VPS
// running one Node process; better-sqlite3 is synchronous and fast).
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, '..', 'db', 'affiliate_factory.sqlite');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

module.exports = db;
