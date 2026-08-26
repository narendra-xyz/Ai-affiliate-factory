// Product Hunter - finds and scores REAL affiliate products.
//
// IMPORTANT: this agent NEVER asks the AI model to invent product data.
// It fetches real products from the configured provider (see
// services/adapters/productData.adapter.js). If no provider is
// configured, it returns a clear "not_configured" result instead of
// fabricating anything. The AI model is only used to SCORE the real
// data it's given (demand potential, content potential, reasoning) -
// never to conjure names/prices/ratings out of thin air.
const BaseAgent = require('./baseAgent');
const db = require('../config/db');
const { fetchRealProducts } = require('../services/adapters/productData.adapter');
const { resolveAffiliateUrl } = require('../services/adapters/affiliateLink.adapter');
const { isAgentConfigured } = require('../services/router.service');

// Deterministic fallback scoring used when the AI model isn't configured
// either - still based entirely on the REAL fields fetched, just a
// transparent weighted formula instead of an LLM's reasoning.
function heuristicScore(p) {
  const commissionScore = Math.min(30, (p.commission_rate || 0) * 1.5);
  const ratingScore = Math.min(25, (p.rating || 0) * 5);
  const reviewScore = Math.min(20, Math.log10((p.review_count || 0) + 1) * 8);
  const priceScore = p.price ? Math.min(15, 15 - Math.min(15, p.price / 100000)) : 5;
  const total = Math.round(commissionScore + ratingScore + reviewScore + priceScore);
  return {
    score: Math.max(0, Math.min(100, total)),
    reason: `Skor otomatis (AI tidak dikonfigurasi): komisi ${p.commission_rate}%, rating ${p.rating}, ${p.review_count} review, harga Rp${p.price}.`,
  };
}

class ProductHunterAgent extends BaseAgent {
  constructor() {
    super('product_hunter', 'Product Hunter');
  }

  async run(taskType, input) {
    if (taskType !== 'hunt_products') throw new Error(`Unsupported task type: ${taskType}`);

    const { niche = null, maxPrice = null, count = 5 } = input || {};

    const fetched = await fetchRealProducts({ niche, maxPrice, count });

    if (!fetched.configured) {
      const err = new Error(
        'NOT_CONFIGURED: Product data provider belum dikonfigurasi (PRODUCT_DATA_PROVIDER_URL). ' +
        'Product Hunter tidak akan mengarang data produk - silakan konfigurasikan provider terlebih dahulu.'
      );
      err.code = 'NOT_CONFIGURED';
      throw err;
    }

    if (fetched.error && fetched.products.length === 0) {
      throw new Error(`Gagal mengambil data produk dari provider: ${fetched.error}`);
    }

    if (fetched.products.length === 0) {
      return { productsFound: 0, products: [], message: 'Provider tidak mengembalikan produk untuk kriteria ini.' };
    }

    const aiConfigured = isAgentConfigured(this.name);
    let scored;

    if (aiConfigured) {
      const prompt = [
        {
          role: 'system',
          content:
            'You are the Product Hunter agent. You are given REAL product data fetched from a live provider - ' +
            'do NOT alter names/prices/ratings. Your only job is to SCORE each product from 0-100 based on ' +
            'demand potential, commission attractiveness, price, rating, and content potential (how easy it ' +
            'would be to make an engaging short video about it), and give a short reason. Respond ONLY as a ' +
            'JSON array aligned by index with the input: [{ score, reason }].',
        },
        { role: 'user', content: JSON.stringify(fetched.products) },
      ];

      try {
        const raw = await this.think(prompt);
        const scores = JSON.parse(raw);
        scored = fetched.products.map((p, i) => ({ ...p, score: scores[i]?.score ?? 0, reason: scores[i]?.reason || '' }));
      } catch (err) {
        this.log('warn', 'AI scoring failed, falling back to heuristic scoring', { error: err.message });
        scored = fetched.products.map((p) => ({ ...p, ...heuristicScore(p) }));
      }
    } else {
      this.log('info', 'AI not configured for product_hunter - using heuristic scoring on real data');
      scored = fetched.products.map((p) => ({ ...p, ...heuristicScore(p) }));
    }

    const insertStmt = db.prepare(`
      INSERT INTO products (
        name, price, commission_rate, commission_amount, rating, review_count, niche, category,
        source, product_url, affiliate_url, source_url, data_source, score, score_reason, status
      ) VALUES (
        @name, @price, @commission_rate, @commission_amount, @rating, @review_count, @niche, @category,
        @source, @product_url, @affiliate_url, @source_url, 'real', @score, @score_reason, 'testing'
      )
    `);

    const saved = [];
    for (const p of scored) {
      if (maxPrice && p.price > maxPrice) continue; // enforce hard constraint on real data

      const affiliate = await resolveAffiliateUrl({ productUrl: p.product_url, existingAffiliateUrl: p.affiliate_url });

      const res = insertStmt.run({
        name: p.name,
        price: p.price || 0,
        commission_rate: p.commission_rate || 0,
        commission_amount: p.commission_amount || 0,
        rating: p.rating || 0,
        review_count: p.review_count || 0,
        niche: niche || p.category || null,
        category: p.category || null,
        source: process.env.PRODUCT_DATA_PROVIDER_URL ? new URL(process.env.PRODUCT_DATA_PROVIDER_URL).hostname : null,
        product_url: p.product_url || null,
        affiliate_url: affiliate.affiliateUrl,
        source_url: p.source_url || null,
        score: p.score || 0,
        score_reason: p.reason || '',
      });

      saved.push({
        id: res.lastInsertRowid,
        ...p,
        affiliate_url: affiliate.affiliateUrl,
        affiliate_link_status: affiliate.configured ? 'ok' : 'not_configured',
      });
    }

    return { productsFound: saved.length, products: saved, dataSource: 'real', aiScoringUsed: aiConfigured };
  }
}

module.exports = ProductHunterAgent;
