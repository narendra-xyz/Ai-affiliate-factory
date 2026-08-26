// Command Center parser. Converts natural language into ONE of a fixed,
// whitelisted set of actions. This is a hard security boundary: the
// system NEVER executes arbitrary shell/code from a command - only these
// pre-approved actions, each with its own validated parameters.
const db = require('../config/db');
const { callAgentModel } = require('./router.service');

const ALLOWED_ACTIONS = [
  'create_videos', // { productId?, count }
  'find_products', // { niche?, maxPrice? }
  'set_niche_focus', // { niche }
  'analyze_failures', // { days? }
  'analyze_low_performers', // { range? }
  'create_variation_of_best', // { count? }
  'replicate_best_format', // { }
  'stop_all_agents', // { }
  'resume_agents', // { }
  'show_profit', // { range }
  'set_max_product_price', // { maxPrice }
];

// Fast path: simple keyword/regex matching for the example commands from
// the spec. Anything that doesn't match falls back to an LLM classifier
// constrained to the same whitelist. ORDER MATTERS: more specific
// patterns must be checked before broader ones (e.g. "performanya buruk"
// before the generic "analisis" catch-all) to avoid misclassification.
function fastMatch(text) {
  const t = text.toLowerCase().trim();

  if (/buat.*\d+.*video/.test(t)) {
    const count = parseInt((t.match(/\d+/) || ['5'])[0], 10);
    return { action: 'create_videos', params: { count } };
  }
  if (/variasi.*(video|format).*terbaik|buat variasi dari video terbaik/.test(t)) {
    const count = parseInt((t.match(/\d+/) || ['3'])[0], 10);
    return { action: 'create_variation_of_best', params: { count } };
  }
  if (/cari produk/.test(t)) return { action: 'find_products', params: {} };
  if (/fokus niche (\w+)/.test(t)) {
    const niche = t.match(/fokus niche (\w+)/)[1];
    return { action: 'set_niche_focus', params: { niche } };
  }
  if (/performa(nya)? (buruk|jelek|rendah)/.test(t)) {
    const range = /minggu/.test(t) ? '7d' : '30d';
    return { action: 'analyze_low_performers', params: { range } };
  }
  if (/analisis|kenapa.*gagal/.test(t)) return { action: 'analyze_failures', params: { days: 3 } };
  if (/ulangi format|performa.*bagus/.test(t)) return { action: 'replicate_best_format', params: {} };
  if (/hentikan semua agent|stop semua agent/.test(t)) return { action: 'stop_all_agents', params: {} };
  if (/tampilkan profit|lihat profit/.test(t)) {
    const range = /minggu/.test(t) ? 'last7Days' : /bulan/.test(t) ? 'thisMonth' : 'today';
    return { action: 'show_profit', params: { range } };
  }
  if (/jangan pilih produk di atas/.test(t)) {
    const match = t.match(/rp\s?([\d.]+)/i);
    const maxPrice = match ? parseInt(match[1].replace(/\./g, ''), 10) : null;
    return maxPrice ? { action: 'set_max_product_price', params: { maxPrice } } : null;
  }
  return null;
}

async function classifyWithModel(text) {
  const prompt = [
    {
      role: 'system',
      content:
        `You classify a natural-language command into exactly one of these actions: ${ALLOWED_ACTIONS.join(', ')}. ` +
        'Extract only the parameters relevant to that action. If nothing fits, use action "unknown". ' +
        'Respond ONLY as JSON: { action, params }.',
    },
    { role: 'user', content: text },
  ];
  const raw = await callAgentModel('command_center', prompt, { model: undefined });
  try {
    return JSON.parse(raw);
  } catch (_) {
    return { action: 'unknown', params: {} };
  }
}

async function parseCommand(rawText) {
  const fast = fastMatch(rawText);
  const parsed = fast || (await classifyWithModel(rawText));

  const isAllowed = ALLOWED_ACTIONS.includes(parsed.action);
  const record = db
    .prepare(
      `INSERT INTO commands (raw_text, parsed_action, parsed_params, status) VALUES (?, ?, ?, ?)`
    )
    .run(rawText, parsed.action, JSON.stringify(parsed.params || {}), isAllowed ? 'received' : 'rejected');

  return {
    commandId: record.lastInsertRowid,
    action: isAllowed ? parsed.action : null,
    params: parsed.params || {},
    rejected: !isAllowed,
  };
}

module.exports = { parseCommand, ALLOWED_ACTIONS };
