// TikTok Shop Shoppable Video endpoints. Purely additive - a separate
// route file from tiktok.routes.js since TikTok Shop Partner Center is a
// distinct API/credential surface from the general TikTok Content
// Posting API. Disabling/not-configuring this route has zero effect on
// any other part of the system.
const express = require('express');
const crypto = require('crypto');
const { z } = require('zod');
const db = require('../config/db');
const { validateBody } = require('../middleware/validate.middleware');
const { requireAuth, requireAuthOrQueryToken } = require('../middleware/auth.middleware');
const { tiktokShopQueue } = require('../services/queue.service');
const logger = require('../utils/logger');

const { buildAuthorizeUrl, exchangeCodeForToken } = require('../services/adapters/tiktok-shop/tiktokShopAuth.adapter');
const { syncProductsToCache } = require('../services/adapters/tiktok-shop/tiktokShopProduct.adapter');
const { encrypt } = require('../services/adapters/tiktok/tokenCrypto');
const { publishShoppableVideo } = require('../services/tiktokShopPublish.service');

const router = express.Router();

// ---- OAuth CSRF state store (separate from tiktok.routes.js's store,
// same simple in-memory pattern) ----
const pendingStates = new Map();
const STATE_TTL_MS = 10 * 60 * 1000;

function issueState() {
  const state = crypto.randomBytes(24).toString('hex');
  pendingStates.set(state, Date.now() + STATE_TTL_MS);
  return state;
}
function consumeState(state) {
  const expiry = pendingStates.get(state);
  pendingStates.delete(state);
  return !!expiry && expiry > Date.now();
}
setInterval(() => {
  const now = Date.now();
  for (const [state, expiry] of pendingStates) if (expiry <= now) pendingStates.delete(state);
}, 5 * 60 * 1000);

// ---- OAuth: connect ----
router.get('/auth/connect', requireAuthOrQueryToken, (req, res) => {
  try {
    const state = issueState();
    res.redirect(buildAuthorizeUrl(state));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---- OAuth: callback (public - protected by state CSRF token, same
// standard OAuth callback model used for tiktok.routes.js) ----
router.get('/auth/callback', async (req, res) => {
  const { code, state, error: shopError } = req.query;

  if (shopError) return res.redirect(`/settings-tiktok-shop.html?error=${encodeURIComponent(String(shopError))}`);
  if (!code || !state || !consumeState(String(state))) {
    return res.redirect(`/settings-tiktok-shop.html?error=${encodeURIComponent('Invalid or expired OAuth state')}`);
  }

  try {
    const tokenResult = await exchangeCodeForToken(String(code));
    if (!tokenResult.ok) {
      return res.redirect(`/settings-tiktok-shop.html?error=${encodeURIComponent(tokenResult.error || 'Token exchange failed')}`);
    }

    const accessExpiresAt = new Date(Date.now() + tokenResult.expiresIn * 1000).toISOString();
    const refreshExpiresAt = tokenResult.refreshExpiresIn
      ? new Date(Date.now() + tokenResult.refreshExpiresIn * 1000).toISOString()
      : null;

    const existing = db.prepare('SELECT id FROM tiktok_shop_accounts WHERE shop_creator_id = ?').get(tokenResult.shopCreatorId);

    if (existing) {
      db.prepare(
        `UPDATE tiktok_shop_accounts SET shop_name = ?, access_token_enc = ?, refresh_token_enc = ?,
         access_token_expires_at = ?, refresh_token_expires_at = ?, scopes = ?, status = 'connected',
         last_error = NULL, updated_at = datetime('now') WHERE id = ?`
      ).run(
        tokenResult.shopName || null, encrypt(tokenResult.accessToken), encrypt(tokenResult.refreshToken),
        accessExpiresAt, refreshExpiresAt, tokenResult.scope || null, existing.id
      );
    } else {
      db.prepare(
        `INSERT INTO tiktok_shop_accounts
         (shop_creator_id, shop_id, shop_name, access_token_enc, refresh_token_enc,
          access_token_expires_at, refresh_token_expires_at, scopes, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'connected')`
      ).run(
        tokenResult.shopCreatorId, tokenResult.shopId || null, tokenResult.shopName || null,
        encrypt(tokenResult.accessToken), encrypt(tokenResult.refreshToken),
        accessExpiresAt, refreshExpiresAt, tokenResult.scope || null
      );
    }

    logger.log('tiktok_shop', 'info', `TikTok Shop account connected: ${tokenResult.shopName || tokenResult.shopCreatorId}`);
    res.redirect('/settings-tiktok-shop.html?connected=1');
  } catch (err) {
    logger.log('tiktok_shop', 'error', 'TikTok Shop OAuth callback failed', { error: err.message });
    res.redirect(`/settings-tiktok-shop.html?error=${encodeURIComponent(err.message)}`);
  }
});

// ---- Accounts ----
router.get('/accounts', requireAuth, (req, res) => {
  res.json(
    db
      .prepare(
        `SELECT id, shop_creator_id, shop_id, shop_name, scopes, status, last_error,
                access_token_expires_at, connected_at, updated_at FROM tiktok_shop_accounts ORDER BY connected_at DESC`
      )
      .all()
  );
});

router.post('/accounts/:id/disconnect', requireAuth, (req, res) => {
  db.prepare(`UPDATE tiktok_shop_accounts SET status = 'disconnected', updated_at = datetime('now') WHERE id = ?`).run(req.params.id);
  logger.log('tiktok_shop', 'info', `TikTok Shop account ${req.params.id} disconnected`);
  res.json({ ok: true });
});

// ---- Product catalog ----
router.post('/accounts/:id/sync-products', requireAuth, async (req, res) => {
  const result = await syncProductsToCache(req.params.id);
  if (!result.ok) return res.status(400).json({ error: result.error, notConfigured: result.notConfigured });
  res.json(result);
});

router.get('/products', requireAuth, (req, res) => {
  const accountId = req.query.accountId;
  const query = accountId
    ? db.prepare(`SELECT * FROM tiktok_shop_products WHERE shop_account_id = ? ORDER BY last_synced_at DESC`).all(accountId)
    : db.prepare(`SELECT * FROM tiktok_shop_products ORDER BY last_synced_at DESC`).all();
  res.json(query);
});

// ---- Product mapping: link an internal affiliate product to a TikTok
// Shop product_id (spec point 4) ----
const mapProductSchema = z.object({ tiktokShopProductId: z.string().min(1).nullable() });

router.patch('/product-mapping/:productId', requireAuth, validateBody(mapProductSchema), (req, res) => {
  db.prepare(`UPDATE products SET tiktok_shop_product_id = ?, updated_at = datetime('now') WHERE id = ?`).run(
    req.body.tiktokShopProductId,
    req.params.productId
  );
  res.json({ ok: true });
});

// ---- Shoppable video publish ----
const publishSchema = z.object({
  videoId: z.number().int(),
  shopAccountId: z.number().int().optional(),
  tiktokShopProductId: z.string().min(1).optional(), // falls back to the linked product's mapping if omitted
  caption: z.string().max(2200).optional(),
});

router.post('/publish', requireAuth, validateBody(publishSchema), async (req, res) => {
  const { videoId, caption } = req.body;
  let { shopAccountId, tiktokShopProductId } = req.body;

  const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(videoId);
  if (!video) return res.status(404).json({ error: 'Video not found' });
  if (!['approved', 'ready_to_publish'].includes(video.status)) {
    return res.status(400).json({ error: `Video status must be approved/ready_to_publish (current: ${video.status})` });
  }
  if (!video.file_path) return res.status(400).json({ error: 'Video has no rendered file to publish' });

  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(video.product_id);
  if (!tiktokShopProductId) {
    if (!product?.tiktok_shop_product_id) {
      return res.status(400).json({
        error: 'Produk video ini belum di-mapping ke TikTok Shop product_id. Hubungkan dulu di halaman Products atau TikTok Shop settings.',
      });
    }
    tiktokShopProductId = product.tiktok_shop_product_id;
  }

  if (!shopAccountId) {
    const connected = db.prepare(`SELECT id FROM tiktok_shop_accounts WHERE status = 'connected' LIMIT 1`).get();
    if (!connected) return res.status(400).json({ error: 'Belum ada akun TikTok Shop yang terhubung. Sambungkan di Settings > TikTok Shop.' });
    shopAccountId = connected.id;
  }

  // Runs through the dedicated queue so it never competes with video
  // rendering or the plain TikTok publish flow, and respects rate limits.
  tiktokShopQueue
    .push(() =>
      publishShoppableVideo({
        videoId,
        shopAccountId,
        tiktokShopProductId,
        internalProductId: video.product_id,
        caption: caption || video.title || '',
      })
    )
    .catch((err) => logger.log('tiktok_shop', 'error', `Shoppable publish job crashed for video ${videoId}`, { error: err.message }));

  res.json({
    status: 'queued',
    note: 'Publish shoppable video berjalan di background - pantau status video & product attachment di halaman ini.',
  });
});

router.get('/publishes/video/:videoId', requireAuth, (req, res) => {
  const row = db
    .prepare(
      `SELECT sp.*, a.shop_name FROM tiktok_shop_publishes sp
       LEFT JOIN tiktok_shop_accounts a ON a.id = sp.shop_account_id
       WHERE sp.video_id = ? ORDER BY sp.created_at DESC LIMIT 1`
    )
    .get(req.params.videoId);
  res.json(row || null);
});

router.get('/publishes', requireAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '30', 10), 100);
  res.json(
    db
      .prepare(
        `SELECT sp.*, v.title as video_title, p.name as product_name
         FROM tiktok_shop_publishes sp
         LEFT JOIN videos v ON v.id = sp.video_id
         LEFT JOIN products p ON p.id = sp.internal_product_id
         ORDER BY sp.created_at DESC LIMIT ?`
      )
      .all(limit)
  );
});

// ---- Webhook: TikTok Shop notifying of an async product link status
// change on a previously published video (spec point 9). Protected by a
// shared secret header, same pattern as the existing n8n webhook. Exact
// payload shape/signature scheme should be verified against current
// TikTok Shop Partner Center docs; this accepts a documented-shape
// payload and maps it defensively. ----
router.post('/webhook/product-link-status', (req, res) => {
  const token = req.headers['x-tiktok-shop-webhook-token'];
  if (!token || token !== process.env.TIKTOK_SHOP_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Invalid webhook token' });
  }

  const { request_id: requestId, video_id: tiktokVideoId, product_link_status: rawStatus, fail_reason: failReason } = req.body || {};
  if (!requestId && !tiktokVideoId) {
    return res.status(400).json({ error: 'request_id or video_id required' });
  }

  const statusMap = { PENDING: 'pending', SUCCESS: 'attached', ATTACHED: 'attached', FAILED: 'failed' };
  const mappedStatus = statusMap[rawStatus] || 'pending';

  const where = requestId ? 'request_id = ?' : 'tiktok_video_id = ?';
  const whereValue = requestId || tiktokVideoId;

  db.prepare(
    `UPDATE tiktok_shop_publishes SET product_attachment_status = ?, attachment_error = ?, updated_at = datetime('now') WHERE ${where}`
  ).run(mappedStatus, mappedStatus === 'failed' ? (failReason || 'Reported failed via webhook') : null, whereValue);

  logger.log('tiktok_shop', 'info', `Webhook updated product_attachment_status=${mappedStatus} for ${where}=${whereValue}`);
  res.json({ ok: true });
});

module.exports = router;
