// Real trend/research data adapter. If TREND_DATA_PROVIDER_URL isn't
// set, Trend Hunter still runs (creative angle brainstorming is a
// legitimate AI use, unlike inventing product facts) but the output is
// explicitly tagged 'ai_generated_heuristic' rather than presented as
// real-time trend intelligence - see trendHunter.agent.js.
require('dotenv').config();

function isConfigured() {
  return !!process.env.TREND_DATA_PROVIDER_URL;
}

async function fetchTrendContext({ niche, productName }) {
  if (!isConfigured()) return { configured: false, context: null };

  try {
    const url = new URL(process.env.TREND_DATA_PROVIDER_URL);
    if (niche) url.searchParams.set('niche', niche);
    if (productName) url.searchParams.set('query', productName);

    const headers = { Accept: 'application/json' };
    if (process.env.TREND_DATA_PROVIDER_KEY) headers.Authorization = `Bearer ${process.env.TREND_DATA_PROVIDER_KEY}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(url.toString(), { headers, signal: controller.signal });
    clearTimeout(timer);

    if (!res.ok) throw new Error(`Provider responded ${res.status}`);
    const data = await res.json();
    return { configured: true, context: data };
  } catch (err) {
    return { configured: true, context: null, error: err.message };
  }
}

module.exports = { fetchTrendContext, isConfigured };
