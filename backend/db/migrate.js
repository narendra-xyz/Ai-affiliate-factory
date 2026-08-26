// Additive migration runner. Two jobs, order matters:
// 1. ALTER TABLE for individual columns on tables that already existed in
//    older versions (CREATE TABLE IF NOT EXISTS does NOT add columns to
//    a table that's already there). This runs FIRST so that any table
//    still missing a newer column gets it before...
// 2. ...schema.sql executes (CREATE TABLE IF NOT EXISTS + CREATE INDEX).
//    Running schema.sql before step 1 could fail: some indexes are
//    defined on columns that may not exist yet on a very old table, and
//    IF NOT EXISTS only guards table/index creation, not missing columns
//    on an existing table. Doing ALTERs first avoids that ordering hazard.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, 'affiliate_factory.sqlite');
const db = new Database(DB_PATH);

function columnExists(table, column) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  return cols.some((c) => c.name === column);
}

function addColumnIfMissing(table, column, definition) {
  if (!columnExists(table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    console.log(`[migrate] added ${table}.${column}`);
  }
}

// Step 1: add columns to tables that may have existed before this column
// was introduced. Tables that don't exist at all yet are skipped here -
// schema.sql (step 2) will create them fresh with every column already
// included, so there's nothing to ALTER for those.
const migrations = [
  ['products', 'category', 'TEXT'],
  ['products', 'source', 'TEXT'],
  ['products', 'product_url', 'TEXT'],
  ['products', 'affiliate_url', 'TEXT'],
  ['products', 'data_source', "TEXT DEFAULT 'unavailable'"],
  ['scripts', 'angle_data_source', 'TEXT'],
  ['videos', 'duration_seconds', 'REAL'],
  ['videos', 'resolution', 'TEXT'],
  ['videos', "storage_status", "TEXT DEFAULT 'not_rendered'"],
  ['videos', 'critic_evaluation_basis', 'TEXT'],
  ['videos', 'critic_suggested_revision', 'TEXT'],
  ['performance_metrics', 'source', "TEXT DEFAULT 'manual'"],
  ['performance_metrics', 'likes', 'INTEGER DEFAULT 0'],
  ['performance_metrics', 'comments', 'INTEGER DEFAULT 0'],
  ['performance_metrics', 'shares', 'INTEGER DEFAULT 0'],
  ['commands', 'progress_current', 'INTEGER DEFAULT 0'],
  ['commands', 'progress_total', 'INTEGER DEFAULT 0'],
  ['products', 'tiktok_shop_product_id', 'TEXT'],
];

for (const [table, column, def] of migrations) {
  const tableExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table);
  if (tableExists) addColumnIfMissing(table, column, def);
}

// Step 2: create any brand new tables/indexes (e.g. tiktok_accounts,
// tiktok_publishes) - safe no-op for anything that already exists, and
// by now every existing table has the columns any new index might need.
const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

console.log('[migrate] done');
db.close();
