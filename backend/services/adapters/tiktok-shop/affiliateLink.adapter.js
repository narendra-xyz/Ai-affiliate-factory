// Affiliate link abstraction. Keeps agent logic independent of which
// affiliate network is behind it (Lynk.id, TikTok Shop Affiliate,
// Shopee Affiliate, etc). If the provider already returns an
// affiliate_url directly (common with data-feed style APIs), that's
// used as-is. Otherwise, if a link-generation endpoint is configured,
// this wraps a product_url into a real tracked affiliate link. If
// neither is configured, this NEVER fabricates a link - it returns null
// and callers must surface that clearly rather than inventing one.
require('dotenv').config();

function isConfigured() {
  return !!process.env.AFFILIATE_PROVIDER_NAME;
}

/**
 * @returns {Promise<{configured:boolean, affiliateUrl:string|null, error?:string}>}
 */
async function resolveAffiliateUrl({ productUrl, existingAffiliateUrl }) {
  if (existingAffiliateUrl) {
    return { configured: true, affiliateUrl: existingAffiliateUrl };
  }
  if (!isConfigured()) {
    return { configured: false, affiliateUrl: null, error: 'AFFILIATE_PROVIDER_NAME not set' };
  }
  if (!process.env.AFFILIATE_LINK_GENERATOR_URL) {
    return { configured: false, affiliateUrl: null, error: 'AFFILIATE_LINK_GENERATOR_URL not set' };
  }
  if (!productUrl) {
    return { configured: true, affiliateUrl: null, error: 'No product_url to generate a link from' };
  }

  try {
    const res = await fetch(process.env.AFFILIATE_LINK_GENERATOR_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.AFFILIATE_PROVIDER_KEY ? { Authorization: `Bearer ${process.env.AFFILIATE_PROVIDER_KEY}` } : {}),
      },
      body: JSON.stringify({ url: productUrl }),
    });
    if (!res.ok) throw new Error(`Link generator responded ${res.status}`);
    const data = await res.json();
    return { configured: true, affiliateUrl: data.affiliate_url || data.url || null };
  } catch (err) {
    return { configured: true, affiliateUrl: null, error: err.message };
  }
}

module.exports = { resolveAffiliateUrl, isConfigured };
