// Fetches the TikTok Shop products available to the connected
// creator/showcase via the official Shop Partner API, and caches them
// locally in tiktok_shop_products so the dashboard can browse/link them
// to internal affiliate products without re-fetching on every page load.
const db = require('../../../config/db');
const { callShopApi } = require('./tiktokShopClient');
const { getValidAccessToken } = require('./tiktokShopTokenManager');

const PAGE_SIZE = 100;

/**
 * @returns {Promise<{ok:boolean, products?:Array, error?:string, notConfigured?:boolean}>}
 */
async function fetchAvailableProducts(shopAccountId) {
  const tokenResult = await getValidAccessToken(shopAccountId);
  if (!tokenResult.ok) return { ok: false, error: tokenResult.error, notConfigured: tokenResult.notConfigured };

  const res = await callShopApi('/product/202309/products/search', {
    method: 'POST',
    accessToken: tokenResult.accessToken,
    query: { page_size: PAGE_SIZE },
    body: { status: 'ACTIVATE' },
  });

  if (!res.ok) return { ok: false, error: res.error || 'Failed to fetch TikTok Shop products', tokenExpired: res.tokenExpired };

  const products = (res.data?.data?.products || []).map((p) => ({
    tiktokShopProductId: p.id || p.product_id,
    name: p.title || p.name,
    price: parseFloat(p.price?.sale_price?.amount || p.price?.original_price?.amount || 0),
    currency: p.price?.currency || null,
    imageUrl: (p.main_images?.[0]?.url || p.images?.[0]?.url) || null,
    availabilityStatus: p.status || null,
    raw: p,
  }));

  return { ok: true, products };
}

/** Fetches fresh products and upserts them into the local cache table. */
async function syncProductsToCache(shopAccountId) {
  const result = await fetchAvailableProducts(shopAccountId);
  if (!result.ok) return result;

  const upsert = db.prepare(
    `INSERT INTO tiktok_shop_products
       (shop_account_id, tiktok_shop_product_id, name, price, currency, image_url, availability_status, raw_data, last_synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(tiktok_shop_product_id) DO UPDATE SET
       name = excluded.name, price = excluded.price, currency = excluded.currency,
       image_url = excluded.image_url, availability_status = excluded.availability_status,
       raw_data = excluded.raw_data, last_synced_at = datetime('now')`
  );

  for (const p of result.products) {
    upsert.run(
      shopAccountId, p.tiktokShopProductId, p.name, p.price, p.currency,
      p.imageUrl, p.availabilityStatus, JSON.stringify(p.raw)
    );
  }

  return { ok: true, count: result.products.length };
}

module.exports = { fetchAvailableProducts, syncProductsToCache };
