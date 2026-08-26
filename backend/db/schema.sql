-- AI Affiliate Factory - SQLite Schema
-- Lightweight schema designed for small VPS (8GB RAM / 4 vCPU)

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT DEFAULT 'admin',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  source_url TEXT,
  price REAL DEFAULT 0,
  commission_rate REAL DEFAULT 0,
  commission_amount REAL DEFAULT 0,
  rating REAL DEFAULT 0,
  review_count INTEGER DEFAULT 0,
  niche TEXT,
  category TEXT,
  source TEXT,           -- name of the data provider/integration this product came from
  product_url TEXT,       -- original product page URL
  affiliate_url TEXT,     -- real affiliate/tracking link from the configured affiliate provider
  data_source TEXT DEFAULT 'unavailable', -- real | ai_estimated | unavailable (see DATA INTEGRITY policy)
  tiktok_shop_product_id TEXT,     -- links this affiliate product to a TikTok Shop product for shoppable video
  score REAL DEFAULT 0,
  score_reason TEXT,
  status TEXT DEFAULT 'testing',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  status TEXT DEFAULT 'idle',
  current_task TEXT,
  last_task TEXT,
  model_config TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_name TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT DEFAULT 'queued',
  input TEXT,
  output TEXT,
  error TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  started_at TEXT,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS scripts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER REFERENCES products(id),
  agent_name TEXT DEFAULT 'script_writer',
  variant_label TEXT,
  hook TEXT,
  body TEXT,
  cta TEXT,
  angle_data_source TEXT, -- live_trend_api | ai_generated_heuristic (honesty tag from Trend Hunter)
  status TEXT DEFAULT 'draft',
  critic_score REAL,
  critic_feedback TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS videos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  script_id INTEGER REFERENCES scripts(id),
  product_id INTEGER REFERENCES products(id),
  title TEXT,
  thumbnail_path TEXT,
  file_path TEXT,
  duration_seconds REAL,
  resolution TEXT,
  storage_status TEXT DEFAULT 'not_rendered', -- not_rendered | local_temp | local_permanent | remote_object_storage
  agent_name TEXT DEFAULT 'content_agent',
  platform TEXT,
  status TEXT DEFAULT 'draft',
  critic_rating REAL,
  critic_evaluation_basis TEXT, -- metadata_and_script | video_frames (honesty tag - never claim video_frames if only script was seen)
  critic_suggested_revision TEXT,
  fail_reason TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  published_at TEXT
);

CREATE TABLE IF NOT EXISTS performance_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id INTEGER REFERENCES videos(id),
  date TEXT NOT NULL,
  views INTEGER DEFAULT 0,
  clicks INTEGER DEFAULT 0,
  orders INTEGER DEFAULT 0,
  commission REAL DEFAULT 0,
  likes INTEGER DEFAULT 0,
  comments INTEGER DEFAULT 0,
  shares INTEGER DEFAULT 0,
  source TEXT DEFAULT 'manual', -- platform_sync (n8n webhook) | manual (operator) | tiktok_api (real TikTok performance sync)
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS affiliate_earnings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER REFERENCES products(id),
  video_id INTEGER REFERENCES videos(id),
  order_ref TEXT,
  amount REAL NOT NULL,
  date TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  description TEXT,
  amount REAL NOT NULL,
  date TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ai_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_name TEXT,
  provider TEXT,
  model TEXT,
  script_id INTEGER REFERENCES scripts(id),
  video_id INTEGER REFERENCES videos(id),
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  estimated_cost REAL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_name TEXT NOT NULL,
  level TEXT DEFAULT 'info',
  message TEXT NOT NULL,
  meta TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS commands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  raw_text TEXT NOT NULL,
  parsed_action TEXT,
  parsed_params TEXT,
  status TEXT DEFAULT 'received',
  progress_current INTEGER DEFAULT 0,
  progress_total INTEGER DEFAULT 0,
  result TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Persists patterns the Money Agent has learned from real performance
-- data (winning formats, warnings about high-traffic/low-conversion
-- products, etc), so future recommendations build on past analysis
-- instead of the AI re-deriving - or re-missing - the same insight every
-- time. This is what "jangan mengulang kesalahan yang sama" is backed by.
CREATE TABLE IF NOT EXISTS learned_insights (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL, -- winning_pattern, warning
  insight_text TEXT NOT NULL,
  source_task_id INTEGER REFERENCES tasks(id),
  created_at TEXT DEFAULT (datetime('now'))
);

-- Tracks which model is currently rate-limited/exhausted per agent, so the
-- router can skip straight to the next free model in the pool instead of
-- re-hitting a model that just failed. Cleared automatically once
-- limited_until passes.
CREATE TABLE IF NOT EXISTS agent_model_status (
  agent_name TEXT NOT NULL,
  model_id TEXT NOT NULL,
  status TEXT DEFAULT 'available', -- available, limited
  limited_until TEXT,
  last_error TEXT,
  updated_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (agent_name, model_id)
);

CREATE INDEX IF NOT EXISTS idx_videos_status ON videos(status);
CREATE INDEX IF NOT EXISTS idx_videos_product ON videos(product_id);
CREATE INDEX IF NOT EXISTS idx_perf_video_date ON performance_metrics(video_id, date);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_logs_agent ON agent_logs(agent_name);

-- ============================================================
-- TikTok integration (additive - does not alter existing tables
-- besides performance_metrics.likes/comments/shares/source above)
-- ============================================================

-- One row per connected TikTok account. Tokens are stored ENCRYPTED
-- (AES-256-GCM via services/adapters/tiktok/tokenCrypto.js) - never
-- stored or logged in plaintext. scopes is the space-separated list of
-- permissions actually granted by TikTok for this account, used to gate
-- publish/analytics calls per-account rather than assuming access.
CREATE TABLE IF NOT EXISTS tiktok_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tiktok_open_id TEXT UNIQUE,
  username TEXT,
  display_name TEXT,
  avatar_url TEXT,
  access_token_enc TEXT,           -- encrypted blob
  refresh_token_enc TEXT,          -- encrypted blob
  access_token_expires_at TEXT,
  refresh_token_expires_at TEXT,
  scopes TEXT,                     -- e.g. "user.info.basic video.publish video.list"
  status TEXT DEFAULT 'connected', -- connected, expired, error, disconnected
  is_autopilot_account INTEGER DEFAULT 0, -- 0/1, which account Content Agent publishes to by default
  last_error TEXT,
  connected_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- One row per publish attempt. Kept even on failure so the publish
-- history/status is fully auditable from the dashboard.
CREATE TABLE IF NOT EXISTS tiktok_publishes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id INTEGER REFERENCES videos(id),
  product_id INTEGER REFERENCES products(id),
  account_id INTEGER REFERENCES tiktok_accounts(id),
  tiktok_post_id TEXT,             -- filled once TikTok returns a published post id
  tiktok_publish_id TEXT,          -- TikTok's internal publish_id used for status polling
  caption TEXT,
  status TEXT DEFAULT 'queued',    -- queued, uploading, processing, published, failed
  error_message TEXT,
  published_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tiktok_publishes_video ON tiktok_publishes(video_id);
CREATE INDEX IF NOT EXISTS idx_tiktok_publishes_status ON tiktok_publishes(status);

-- ============================================================
-- TikTok Shop integration (additive - Shop Partner Center API is a
-- separate auth/API surface from the general TikTok Content Posting
-- API used by tiktok_accounts/tiktok_publishes above). Nothing here
-- alters existing tiktok_* tables or any other part of the system.
-- ============================================================

-- A TikTok Shop Creator authorization is functionally distinct from a
-- regular TikTok Login Kit connection (different app_key/app_secret
-- registered in TikTok Shop Partner Center, different token). A creator
-- may have both connected - linked_tiktok_account_id is optional context,
-- not a hard dependency.
CREATE TABLE IF NOT EXISTS tiktok_shop_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  linked_tiktok_account_id INTEGER REFERENCES tiktok_accounts(id),
  shop_creator_id TEXT UNIQUE,      -- TikTok Shop's creator/open identifier
  shop_id TEXT,                     -- TikTok Shop's shop identifier, if applicable
  shop_name TEXT,
  access_token_enc TEXT,            -- encrypted (reuses tiktok token crypto)
  refresh_token_enc TEXT,           -- encrypted
  access_token_expires_at TEXT,
  refresh_token_expires_at TEXT,
  scopes TEXT,                      -- granted Shop permissions, e.g. "product.read video.upload"
  status TEXT DEFAULT 'connected',  -- connected, expired, error, disconnected
  last_error TEXT,
  connected_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Local cache of TikTok Shop products available to the connected
-- creator/showcase, refreshed on demand from the Shop Partner API. This
-- is what the internal `products` table maps to via
-- products.tiktok_shop_product_id (added via migrate.js).
CREATE TABLE IF NOT EXISTS tiktok_shop_products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_account_id INTEGER REFERENCES tiktok_shop_accounts(id),
  tiktok_shop_product_id TEXT UNIQUE NOT NULL,
  name TEXT,
  price REAL,
  currency TEXT,
  image_url TEXT,
  availability_status TEXT,         -- as reported by TikTok Shop (e.g. ACTIVATE, DEACTIVATE)
  raw_data TEXT,                    -- full JSON response for fields not modeled explicitly
  last_synced_at TEXT DEFAULT (datetime('now'))
);

-- One row per shoppable video publish attempt. video_status and
-- product_attachment_status are DELIBERATELY separate columns (per spec
-- point 10) - a video can be fully published while its product
-- attachment failed, and that must never be reported as "fully
-- published" to the dashboard.
CREATE TABLE IF NOT EXISTS tiktok_shop_publishes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id INTEGER REFERENCES videos(id),
  internal_product_id INTEGER REFERENCES products(id),
  shop_account_id INTEGER REFERENCES tiktok_shop_accounts(id),
  tiktok_shop_product_id TEXT,
  tiktok_video_id TEXT,             -- TikTok's video/post id once created
  request_id TEXT,                  -- TikTok's request/publish id for tracing + status polling
  precheck_status TEXT DEFAULT 'not_run', -- not_run, passed, failed, not_available
  precheck_result TEXT,             -- JSON detail from the precheck call, if available
  video_status TEXT DEFAULT 'queued',      -- queued, uploading, processing, published, failed
  product_attachment_status TEXT DEFAULT 'not_attempted', -- not_attempted, pending, attached, failed
  video_error TEXT,
  attachment_error TEXT,
  caption TEXT,
  published_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tiktok_shop_publishes_video ON tiktok_shop_publishes(video_id);
CREATE INDEX IF NOT EXISTS idx_tiktok_shop_publishes_status ON tiktok_shop_publishes(video_status, product_attachment_status);
CREATE INDEX IF NOT EXISTS idx_tiktok_shop_products_account ON tiktok_shop_products(shop_account_id);
