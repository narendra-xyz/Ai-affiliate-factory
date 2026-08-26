// Real product data adapter. This is the ONLY place product data enters
// the system from an external source. If PRODUCT_DATA_PROVIDER_URL is
// not set, this returns { configured: false } and Product Hunter MUST
// NOT ask an LLM to invent products to fill the gap - see productHunter.agent.js.
//
// The adapter expects the configured endpoint to return JSON in the
// shape: { products: [{ name, price, url, affiliate_url, rating,
// review_count, commission_rate, category, image_url }, ...] }
// Adjust FIELD MAPPING below to match your actual provider's response
// shape (e.g. Lynk.id, a scraping service, or an affiliate network API).
require('dotenv').config();

const TIMEOUT_MS = 15000;
const MAX_RETRIES = 2;

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function isConfigured() {
  return !!process.env.PRODUCT_DATA_PROVIDER_URL;
}

/**
 * Fetches real product data from the configured provider.
 * @returns {Promise<{configured:boolean, products:Array, error?:string}>}
 */
async function fetchRealProducts({ niche, maxPrice, count = 10 } = {}) {
  if (!isConfigured()) {
    return { configured: false, products: [], error: 'PRODUCT_DATA_PROVIDER_URL not set' };
  }

  const url = new URL(process.env.PRODUCT_DATA_PROVIDER_URL);
  if (niche) url.searchParams.set('niche', niche);
  if (maxPrice) url.searchParams.set('max_price', String(maxPrice));
  url.searchParams.set('limit', String(count));

  const headers = { Accept: 'application/json' };
  if (process.env.PRODUCT_DATA_PROVIDER_KEY) {
    headers.Authorization = `Bearer ${process.env.PRODUCT_DATA_PROVIDER_KEY}`;
  }

  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetchWithTimeout(url.toString(), { headers }, TIMEOUT_MS);
      if (!res.ok) throw new Error(`Provider responded ${res.status}: ${await res.text()}`);
      const data = await res.json();
      const rawProducts = Array.isArray(data.products) ? data.products : Array.isArray(data) ? data : [];

      // Field mapping - adjust here if your provider uses different keys.
      const products = rawProducts.map((p) => ({
        name: p.name || p.title || 'Unnamed product',
        price: Number(p.price ?? p.price_idr ?? 0),
        commission_rate: Number(p.commission_rate ?? p.commission_percent ?? 0),
        commission_amount: Number(p.commission_amount ?? 0),
        rating: Number(p.rating ?? 0),
        review_count: Number(p.review_count ?? p.reviews ?? 0),
        category: p.category || p.niche || niche || null,
        product_url: p.url || p.product_url || null,
        affiliate_url: p.affiliate_url || p.tracking_url || null,
        image_url: p.image_url || p.image || null,
        source_url: url.origin,
      }));

      return { configured: true, products };
    } catch (err) {
      lastError = err;
      if (attempt < MAX_RETRIES) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }

  return { configured: true, products: [], error: `Failed to fetch after ${MAX_RETRIES + 1} attempts: ${lastError.message}` };
}

module.exports = { fetchRealProducts, isConfigured };
