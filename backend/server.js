require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');

const { requireAuth, requireAuthOrQueryToken } = require('./middleware/auth.middleware');
const { apiLimiter } = require('./middleware/rateLimit.middleware');

const authRoutes = require('./routes/auth.routes');
const dashboardRoutes = require('./routes/dashboard.routes');
const productsRoutes = require('./routes/products.routes');
const videosRoutes = require('./routes/videos.routes');
const agentsRoutes = require('./routes/agents.routes');
const commandsRoutes = require('./routes/commands.routes');
const financeRoutes = require('./routes/finance.routes');
const systemRoutes = require('./routes/system.routes');
const n8nRoutes = require('./routes/n8n.routes');
const tiktokRoutes = require('./routes/tiktok.routes');
const tiktokShopRoutes = require('./routes/tiktok-shop.routes');

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(apiLimiter);

// Public
app.use('/api/auth', authRoutes);
app.use('/api/n8n', n8nRoutes); // protected internally by shared secret, not JWT
// TikTok routes handle auth per-endpoint internally (OAuth callback must
// stay public - protected by its own CSRF state token instead of a JWT,
// since it's hit directly by TikTok's server-side redirect).
app.use('/api/tiktok', tiktokRoutes);
// Same rationale as /api/tiktok - TikTok Shop's OAuth callback and
// product-link webhook must stay reachable without a dashboard JWT.
app.use('/api/tiktok-shop', tiktokShopRoutes);

// Protected (dashboard requires login)
app.use('/api/dashboard', requireAuth, dashboardRoutes);
app.use('/api/products', requireAuth, productsRoutes);
app.use('/api/videos', requireAuth, videosRoutes);
app.use('/api/agents', requireAuth, agentsRoutes);
app.use('/api/commands', requireAuth, commandsRoutes);
app.use('/api/finance', requireAuth, financeRoutes);
app.use('/api/system', requireAuth, systemRoutes);

// Serve the static dashboard frontend
app.use(express.static(require('path').join(__dirname, '..', 'frontend')));

// Serve locally-stored rendered videos/thumbnails (local_permanent storage
// status) so the dashboard can actually preview them. Auth is enforced by
// requireAuth on the API paths that expose file_path/thumbnail_path;
// this static route itself is intentionally read-only and scoped to only
// the video storage directory, nothing else on disk.
app.use('/media/videos', requireAuthOrQueryToken, express.static(require('./services/adapters/storage.adapter').LOCAL_PERMANENT_DIR));

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'ai-affiliate-factory' }));

// Central error handler - never leak stack traces, never crash the process.
app.use((err, req, res, next) => {
  console.error('[unhandled]', err);
  res.status(500).json({ error: 'Internal server error' });
});

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`AI Affiliate Factory backend running on port ${PORT}`);
});

// Enforce local video storage retention (max GB / max age) so disk usage
// on the VPS never grows unbounded - runs once shortly after startup,
// then every hour.
const { enforceLocalRetention } = require('./services/adapters/storage.adapter');
setTimeout(() => enforceLocalRetention(), 30000);
setInterval(() => enforceLocalRetention(), 60 * 60 * 1000);

// Periodic TikTok performance sync - purely additive, no-ops harmlessly
// if TikTok isn't configured or no videos are published yet.
const { syncAllPublishedVideos } = require('./services/tiktokPerformanceSync.service');
const TIKTOK_SYNC_INTERVAL_MS = parseInt(process.env.TIKTOK_PERFORMANCE_SYNC_INTERVAL_MS || '1800000', 10); // 30 min default
setTimeout(() => syncAllPublishedVideos().catch(() => {}), 45000);
setInterval(() => syncAllPublishedVideos().catch(() => {}), TIKTOK_SYNC_INTERVAL_MS);
