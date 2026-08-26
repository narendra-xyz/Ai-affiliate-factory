// Central, honest source of truth for whether each external integration
// is actually configured. Nothing in this system should silently pretend
// an integration works - every agent/adapter that depends on one of
// these checks this registry (or does the equivalent env check itself)
// and returns a clear "not_configured" result instead of fabricating
// data or a fake success.
require('dotenv').config();
const { spawnSync } = require('child_process');

function has(...envVars) {
  return envVars.every((v) => !!process.env[v] && process.env[v].trim().length > 0);
}

function binaryAvailable(bin) {
  try {
    const res = spawnSync('which', [bin]);
    return res.status === 0;
  } catch (_) {
    return false;
  }
}

function getIntegrationStatus() {
  const aiModelsConfigured = [
    'NINEROUTER_MODELS_PRODUCT_HUNTER',
    'NINEROUTER_MODELS_TREND_HUNTER',
    'NINEROUTER_MODELS_SCRIPT_WRITER',
    'NINEROUTER_MODELS_CONTENT_AGENT',
    'NINEROUTER_MODELS_CRITIC_AGENT',
    'NINEROUTER_MODELS_MONEY_AGENT',
  ].filter((v) => has(v));

  const ttsProvider = process.env.TTS_PROVIDER || 'local_espeak';
  const ttsReady = ttsProvider === 'local_espeak' ? binaryAvailable('espeak-ng') : has('TTS_API_URL', 'TTS_API_KEY');

  return [
    {
      key: 'ai_gateway',
      name: '9Router (AI Gateway)',
      configured: has('NINEROUTER_API_KEY', 'NINEROUTER_BASE_URL'),
      detail: has('NINEROUTER_API_KEY', 'NINEROUTER_BASE_URL')
        ? `${aiModelsConfigured.length}/6 agent memiliki model terkonfigurasi`
        : 'Set NINEROUTER_API_KEY dan NINEROUTER_BASE_URL di .env',
    },
    {
      key: 'product_data',
      name: 'Product Data Provider',
      configured: has('PRODUCT_DATA_PROVIDER_URL'),
      detail: has('PRODUCT_DATA_PROVIDER_URL')
        ? 'Product Hunter mengambil data produk nyata dari provider ini'
        : 'Belum ada sumber data produk nyata. Product Hunter tidak akan mengarang data - set PRODUCT_DATA_PROVIDER_URL di .env',
    },
    {
      key: 'trend_data',
      name: 'Trend/Research Provider',
      configured: has('TREND_DATA_PROVIDER_URL'),
      detail: has('TREND_DATA_PROVIDER_URL')
        ? 'Trend Hunter menggunakan data trend real-time'
        : 'Belum ada sumber trend real-time. Trend Hunter memakai brainstorm AI (ditandai ai_generated_heuristic, bukan data real-time)',
    },
    {
      key: 'tts',
      name: 'Text-to-Speech',
      configured: ttsReady,
      detail: ttsReady
        ? `Provider aktif: ${ttsProvider}`
        : ttsProvider === 'local_espeak'
        ? 'espeak-ng belum terinstall di VPS. Jalankan: apt-get install espeak-ng'
        : 'Set TTS_API_URL dan TTS_API_KEY di .env, atau gunakan TTS_PROVIDER=local_espeak',
    },
    {
      key: 'visual_media',
      name: 'Visual/Stock Media Provider',
      configured: has('VISUAL_MEDIA_PROVIDER_URL'),
      detail: has('VISUAL_MEDIA_PROVIDER_URL')
        ? 'Video memakai stock footage/gambar dari provider ini (prioritas utama)'
        : 'Belum dikonfigurasi - Content Agent pakai gambar produk asli (jika ada) atau fallback ke visual kartu teks buatan FFmpeg',
    },
    {
      key: 'affiliate_provider',
      name: 'Affiliate Link Provider',
      configured: has('AFFILIATE_PROVIDER_NAME'),
      detail: has('AFFILIATE_PROVIDER_NAME')
        ? `Link affiliate dari: ${process.env.AFFILIATE_PROVIDER_NAME}`
        : 'Belum dikonfigurasi - produk tidak akan memiliki affiliate_url sampai provider di-set',
    },
    {
      key: 'publishing',
      name: 'Publishing Provider',
      configured: has('PUBLISHING_PROVIDER_NAME'),
      detail: has('PUBLISHING_PROVIDER_NAME')
        ? `Publish otomatis via: ${process.env.PUBLISHING_PROVIDER_NAME}`
        : 'Belum dikonfigurasi - video yang sudah ready_to_publish harus dipublikasikan manual',
    },
    {
      key: 'analytics_sync',
      name: 'Analytics Sync',
      configured: has('N8N_BASE_URL', 'N8N_WEBHOOK_TOKEN'),
      detail: has('N8N_BASE_URL', 'N8N_WEBHOOK_TOKEN')
        ? 'Performance metrics disinkron via n8n webhook'
        : 'Set N8N_BASE_URL dan N8N_WEBHOOK_TOKEN, lalu aktifkan workflow performance-sync.json',
    },
    {
      key: 'object_storage',
      name: 'Permanent/Object Storage',
      configured: false,
      detail:
        'Belum diimplementasikan penuh (adapter ada di storage.adapter.js tapi upload S3 masih stub - ' +
        'perlu tambahan SDK provider). Video final saat ini selalu disimpan permanen di disk lokal VPS, bukan temp.',
    },
    {
      key: 'ffmpeg',
      name: 'FFmpeg (video render engine)',
      configured: binaryAvailable('ffmpeg'),
      detail: binaryAvailable('ffmpeg') ? 'Terinstall dan siap dipakai' : 'FFmpeg tidak ditemukan - install via apt-get install ffmpeg',
    },
    (() => {
      const appConfigured = has('TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET', 'TIKTOK_REDIRECT_URI', 'TIKTOK_TOKEN_ENCRYPTION_KEY');
      let connectedCount = 0;
      let autopilotConnected = false;
      if (appConfigured) {
        try {
          const db = require('../config/db');
          const row = db.prepare(`SELECT COUNT(*) as n FROM tiktok_accounts WHERE status = 'connected'`).get();
          connectedCount = row.n;
          const autopilot = db.prepare(`SELECT id FROM tiktok_accounts WHERE is_autopilot_account = 1 AND status = 'connected'`).get();
          autopilotConnected = !!autopilot;
        } catch (_) {
          // DB not ready yet at boot time - treat as no accounts connected
        }
      }
      return {
        key: 'tiktok',
        name: 'TikTok Integration',
        configured: appConfigured && connectedCount > 0,
        detail: !appConfigured
          ? 'App belum dikonfigurasi. Set TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET, TIKTOK_REDIRECT_URI, TIKTOK_TOKEN_ENCRYPTION_KEY di .env'
          : connectedCount === 0
          ? 'App sudah dikonfigurasi tapi belum ada akun TikTok yang terhubung - buka Settings > TikTok'
          : `${connectedCount} akun terhubung${autopilotConnected ? ', akun autopilot sudah diset' : ' - belum ada akun autopilot yang diset'}`,
      };
    })(),
    (() => {
      const appConfigured = has('TIKTOK_SHOP_APP_KEY', 'TIKTOK_SHOP_APP_SECRET', 'TIKTOK_SHOP_REDIRECT_URI', 'TIKTOK_TOKEN_ENCRYPTION_KEY');
      let connectedCount = 0;
      let mappedProductCount = 0;
      if (appConfigured) {
        try {
          const db = require('../config/db');
          connectedCount = db.prepare(`SELECT COUNT(*) as n FROM tiktok_shop_accounts WHERE status = 'connected'`).get().n;
          mappedProductCount = db.prepare(`SELECT COUNT(*) as n FROM products WHERE tiktok_shop_product_id IS NOT NULL`).get().n;
        } catch (_) {
          // DB not ready yet at boot time
        }
      }
      return {
        key: 'tiktok_shop',
        name: 'TikTok Shop (Shoppable Video)',
        configured: appConfigured && connectedCount > 0,
        detail: !appConfigured
          ? 'App TikTok Shop Partner Center belum dikonfigurasi. Set TIKTOK_SHOP_APP_KEY, TIKTOK_SHOP_APP_SECRET, TIKTOK_SHOP_REDIRECT_URI di .env'
          : connectedCount === 0
          ? 'App sudah dikonfigurasi tapi belum ada akun TikTok Shop Creator yang terhubung - buka Settings > TikTok Shop'
          : `${connectedCount} akun Shop terhubung, ${mappedProductCount} produk sudah di-mapping ke TikTok Shop product_id`,
      };
    })(),
  ];
}

module.exports = { getIntegrationStatus, has, binaryAvailable };
