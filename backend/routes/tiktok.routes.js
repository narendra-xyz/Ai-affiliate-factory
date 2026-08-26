// TikTok integration endpoints. Purely additive - does not modify any
// existing route, agent, or dashboard behavior. Every endpoint here can
// be safely ignored/disabled by simply not configuring TIKTOK_CLIENT_KEY;
// the rest of the system (agents, n8n, 9Router, video pipeline) is
// entirely unaffected either way.
const express = require('express');
const crypto = require('crypto');
const { z } = require('zod');
const db = require('../config/db');
const { validateBody } = require('../middleware/validate.middleware');
const { requireAuth, requireAuthOrQueryToken } = require('../middleware/auth.middleware');
const { tiktokQueue } = require('../services/queue.service');
const logger = require('../utils/logger');

const { buildAuthorizeUrl, exchangeCodeForToken } = require('../services/adapters/tiktok/tiktokAuth.adapter');
const { fetchUserInfo, refreshAccountInfo } = require('../services/adapters/tiktok/tiktokAccount.adapter');
const { publishVideo, pollPublishStatus } = require('../services/adapters/tiktok/tiktokPublish.adapter');
const { encrypt } = require('../services/adapters/tiktok/tokenCrypto');
const { syncAllPublishedVideos } = require('../services/tiktokPerformanceSync.service');

const router = express.Router();

// ---- OAuth CSRF state store (in-memory, single-process) ----
const pendingStates = new Map(); // state -> expiry timestamp
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

// ---- OAuth: connect (browser full-page redirect, so token comes via query) ----
router.get('/auth/connect', requireAuthOrQueryToken, (req, res) => {
  try {
    const state = issueState();
    const url = buildAuthorizeUrl(state);
    res.redirect(url);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---- OAuth: callback (hit directly by TikTok's redirect - public route,
// protected by the state CSRF token instead of a JWT, which is the
// standard OAuth callback security model) ----
router.get('/auth/callback', async (req, res) => {
  const { code, state, error: tiktokError } = req.query;

  if (tiktokError) {
    return res.redirect(`/settings-tiktok.html?error=${encodeURIComponent(String(tiktokError))}`);
  }
  if (!code || !state || !consumeState(String(state))) {
    return res.redirect(`/settings-tiktok.html?error=${encodeURIComponent('Invalid or expired OAuth state')}`);
  }

  try {
    const tokenResult = await exchangeCodeForToken(String(code));
    if (!tokenResult.ok) {
      return res.redirect(`/settings-tiktok.html?error=${encodeURIComponent(tokenResult.error || 'Token exchange failed')}`);
    }

    const infoResult = await fetchUserInfo(tokenResult.accessToken);
    const info = infoResult.ok ? infoResult.info : {};

    const accessExpiresAt = new Date(Date.now() + tokenResult.expiresIn * 1000).toISOString();
    const refreshExpiresAt = tokenResult.refreshExpiresIn
      ? new Date(Date.now() + tokenResult.refreshExpiresIn * 1000).toISOString()
      : null;

    const existing = db.prepare('SELECT id FROM tiktok_accounts WHERE tiktok_open_id = ?').get(tokenResult.openId);

    if (existing) {
      db.prepare(
        `UPDATE tiktok_accounts SET username = ?, display_name = ?, avatar_url = ?,
         access_token_enc = ?, refresh_token_enc = ?, access_token_expires_at = ?,
         refresh_token_expires_at = ?, scopes = ?, status = 'connected', last_error = NULL,
         updated_at = datetime('now') WHERE id = ?`
      ).run(
        info.username || null, info.display_name || null, info.avatar_url || null,
        encrypt(tokenResult.accessToken), encrypt(tokenResult.refreshToken),
        accessExpiresAt, refreshExpiresAt, tokenResult.scope || null, existing.id
      );
    } else {
      const isFirstAccount = db.prepare('SELECT COUNT(*) as n FROM tiktok_accounts').get().n === 0;
      db.prepare(
        `INSERT INTO tiktok_accounts
         (tiktok_open_id, username, display_name, avatar_url, access_token_enc, refresh_token_enc,
          access_token_expires_at, refresh_token_expires_at, scopes, status, is_autopilot_account)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'connected', ?)`
      ).run(
        tokenResult.openId, info.username || null, info.display_name || null, info.avatar_url || null,
        encrypt(tokenResult.accessToken), encrypt(tokenResult.refreshToken),
        accessExpiresAt, refreshExpiresAt, tokenResult.scope || null, isFirstAccount ? 1 : 0
      );
    }

    logger.log('tiktok', 'info', `TikTok account connected: ${info.username || tokenResult.openId}`);
    res.redirect('/settings-tiktok.html?connected=1');
  } catch (err) {
    logger.log('tiktok', 'error', 'OAuth callback failed', { error: err.message });
    res.redirect(`/settings-tiktok.html?error=${encodeURIComponent(err.message)}`);
  }
});

// ---- Accounts management ----
router.get('/accounts', requireAuth, (req, res) => {
  const accounts = db
    .prepare(
      `SELECT id, tiktok_open_id, username, display_name, avatar_url, scopes, status,
              is_autopilot_account, last_error, connected_at, updated_at,
              access_token_expires_at FROM tiktok_accounts ORDER BY connected_at DESC`
    )
    .all();
  res.json(accounts);
});

router.post('/accounts/:id/refresh-info', requireAuth, async (req, res) => {
  const result = await refreshAccountInfo(req.params.id);
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json(result.info);
});

router.post('/accounts/:id/set-autopilot', requireAuth, (req, res) => {
  const account = db.prepare('SELECT * FROM tiktok_accounts WHERE id = ?').get(req.params.id);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  db.prepare(`UPDATE tiktok_accounts SET is_autopilot_account = 0`).run();
  db.prepare(`UPDATE tiktok_accounts SET is_autopilot_account = 1 WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

router.post('/accounts/:id/disconnect', requireAuth, (req, res) => {
  // Local disconnect only - we deliberately do NOT call TikTok's token
  // revoke endpoint automatically here, since disconnecting locally
  // should always succeed even if TikTok's API is unreachable. The
  // stored tokens are simply no longer used once status = 'disconnected'.
  db.prepare(
    `UPDATE tiktok_accounts SET status = 'disconnected', is_autopilot_account = 0, updated_at = datetime('now') WHERE id = ?`
  ).run(req.params.id);
  logger.log('tiktok', 'info', `TikTok account ${req.params.id} disconnected`);
  res.json({ ok: true });
});

// ---- Publishing ----
const publishSchema = z.object({
  videoId: z.number().int(),
  accountId: z.number().int().optional(), // defaults to the autopilot account
  caption: z.string().max(2200).optional(),
});

router.post('/publish', requireAuth, validateBody(publishSchema), async (req, res) => {
  const { videoId, caption } = req.body;
  let { accountId } = req.body;

  const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(videoId);
  if (!video) return res.status(404).json({ error: 'Video not found' });
  if (!['approved', 'ready_to_publish'].includes(video.status)) {
    return res.status(400).json({ error: `Video status must be approved/ready_to_publish (current: ${video.status})` });
  }
  if (!video.file_path) return res.status(400).json({ error: 'Video has no rendered file to publish' });

  if (!accountId) {
    const autopilot = db.prepare(`SELECT id FROM tiktok_accounts WHERE is_autopilot_account = 1 AND status = 'connected'`).get();
    if (!autopilot) return res.status(400).json({ error: 'No autopilot TikTok account configured. Set one in Settings > TikTok.' });
    accountId = autopilot.id;
  }

  const finalCaption = caption || [video.title].filter(Boolean).join(' ');

  const pubRes = db
    .prepare(
      `INSERT INTO tiktok_publishes (video_id, product_id, account_id, caption, status)
       VALUES (?, ?, ?, ?, 'queued')`
    )
    .run(videoId, video.product_id, accountId, finalCaption);
  const publishRowId = pubRes.lastInsertRowid;

  // Runs through the dedicated low-concurrency TikTok queue so it never
  // competes with video rendering and respects TikTok's rate limits.
  tiktokQueue
    .push(async () => {
      db.prepare(`UPDATE tiktok_publishes SET status = 'uploading', updated_at = datetime('now') WHERE id = ?`).run(publishRowId);

      const initResult = await publishVideo({ accountId, filePath: video.file_path, caption: finalCaption });
      if (!initResult.ok) {
        db.prepare(`UPDATE tiktok_publishes SET status = 'failed', error_message = ? WHERE id = ?`).run(initResult.error, publishRowId);
        return;
      }

      db.prepare(
        `UPDATE tiktok_publishes SET status = 'processing', tiktok_publish_id = ?, updated_at = datetime('now') WHERE id = ?`
      ).run(initResult.publishId, publishRowId);

      const statusResult = await pollPublishStatus({ accountId, publishId: initResult.publishId });
      if (!statusResult.ok) {
        db.prepare(`UPDATE tiktok_publishes SET status = 'failed', error_message = ? WHERE id = ?`).run(statusResult.error, publishRowId);
        return;
      }

      db.prepare(
        `UPDATE tiktok_publishes SET status = 'published', tiktok_post_id = ?, published_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
      ).run(statusResult.postId, publishRowId);
      db.prepare(`UPDATE videos SET status = 'published', published_at = datetime('now') WHERE id = ?`).run(videoId);

      logger.log('tiktok', 'info', `Video ${videoId} published to TikTok, post_id=${statusResult.postId}`);
    })
    .catch((err) => {
      db.prepare(`UPDATE tiktok_publishes SET status = 'failed', error_message = ? WHERE id = ?`).run(err.message, publishRowId);
      logger.log('tiktok', 'error', `Publish job crashed for video ${videoId}`, { error: err.message });
    });

  res.json({ publishRowId, status: 'queued', note: 'Publishing berjalan di background - pantau statusnya di halaman ini.' });
});

router.get('/publishes', requireAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '30', 10), 100);
  res.json(
    db
      .prepare(
        `SELECT p.*, v.title as video_title, a.username as account_username
         FROM tiktok_publishes p
         LEFT JOIN videos v ON v.id = p.video_id
         LEFT JOIN tiktok_accounts a ON a.id = p.account_id
         ORDER BY p.created_at DESC LIMIT ?`
      )
      .all(limit)
  );
});

router.get('/publishes/video/:videoId', requireAuth, (req, res) => {
  const row = db
    .prepare(`SELECT * FROM tiktok_publishes WHERE video_id = ? ORDER BY created_at DESC LIMIT 1`)
    .get(req.params.videoId);
  res.json(row || null);
});

// ---- Performance sync ----
router.post('/performance-sync', requireAuth, async (req, res) => {
  const result = await syncAllPublishedVideos();
  res.json(result);
});

module.exports = router;
