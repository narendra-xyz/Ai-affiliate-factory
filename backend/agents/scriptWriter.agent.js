// Script Writer - turns a product + angle into multiple short-form
// script variants, each with a strong opening hook and a natural,
// non-pushy CTA.
const BaseAgent = require('./baseAgent');
const db = require('../config/db');

class ScriptWriterAgent extends BaseAgent {
  constructor() {
    super('script_writer', 'Script Writer');
  }

  async run(taskType, input) {
    if (taskType !== 'write_scripts') throw new Error(`Unsupported task type: ${taskType}`);

    const { productId, angle, angleDataSource = 'ai_generated_heuristic', variantCount = 3 } = input || {};
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
    if (!product) throw new Error(`Product ${productId} not found`);

    const prompt = [
      {
        role: 'system',
        content:
          `You are the Script Writer agent for faceless short-form affiliate video. ` +
          `Write ${variantCount} distinct script variants for the given product and angle. ` +
          'Each script must have a strong hook in the first line, a clear body, and a natural CTA ' +
          '(no hard-sell language). Respond ONLY as a JSON array of objects: ' +
          '{ variant_label, hook, body, cta }.',
      },
      {
        role: 'user',
        content: JSON.stringify({ product, angle }),
      },
    ];

    const raw = await this.think(prompt);
    let variants;
    try {
      variants = JSON.parse(raw);
    } catch (err) {
      throw new Error('Script Writer returned non-JSON output');
    }

    const insertStmt = db.prepare(`
      INSERT INTO scripts (product_id, agent_name, variant_label, hook, body, cta, angle_data_source, status)
      VALUES (?, 'script_writer', ?, ?, ?, ?, ?, 'draft')
    `);

    const saved = variants.map((v) => {
      const res = insertStmt.run(productId, v.variant_label, v.hook, v.body, v.cta, angleDataSource);
      return { id: res.lastInsertRowid, ...v };
    });

    return { productId, scripts: saved };
  }
}

module.exports = ScriptWriterAgent;
