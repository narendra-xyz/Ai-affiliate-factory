// Critic Agent - evaluates scripts and videos before publishing. Scores
// hook strength, clarity, appeal, CTA quality, product relevance, and
// likely retention. Returns a revised version when the result is weak.
//
// HONESTY RULE: critiqueVideo tries to actually extract real frames from
// the rendered MP4 and send them to the AI model as image input. If that
// fails (no file yet, ffmpeg issue, or the configured model doesn't
// accept images), it falls back to metadata+script-only evaluation - and
// every result is tagged with which one actually happened
// (evaluation_basis), so nothing pretends to have "watched" a video it
// only read a description of.
const BaseAgent = require('./baseAgent');
const db = require('../config/db');
const { extractFrames } = require('../services/adapters/frameExtractor.service');

const PASS_THRESHOLD = 70; // out of 100

class CriticAgent extends BaseAgent {
  constructor() {
    super('critic_agent', 'Critic Agent');
  }

  async run(taskType, input) {
    if (taskType === 'critique_script') return this.critiqueScript(input);
    if (taskType === 'critique_video') return this.critiqueVideo(input);
    throw new Error(`Unsupported task type: ${taskType}`);
  }

  async critiqueScript({ scriptId }) {
    const script = db.prepare('SELECT * FROM scripts WHERE id = ?').get(scriptId);
    if (!script) throw new Error(`Script ${scriptId} not found`);

    const prompt = [
      {
        role: 'system',
        content:
          'You are the Critic agent. Score the script from 0-100 on hook strength, clarity, appeal, ' +
          'CTA quality, and product relevance (combined into one overall score). If the score is below ' +
          `${PASS_THRESHOLD}, include a rewritten version. Respond ONLY as JSON: ` +
          '{ score, feedback, rewritten_hook?, rewritten_body?, rewritten_cta? }.',
      },
      { role: 'user', content: JSON.stringify(script) },
    ];

    const raw = await this.think(prompt, {}, { scriptId });
    const critique = JSON.parse(raw);

    const status = critique.score >= PASS_THRESHOLD ? 'approved' : 'rejected';
    db.prepare(
      `UPDATE scripts SET status = ?, critic_score = ?, critic_feedback = ? WHERE id = ?`
    ).run(status, critique.score, critique.feedback, scriptId);

    return { scriptId, status, ...critique };
  }

  async critiqueVideo({ videoId }) {
    const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(videoId);
    if (!video) throw new Error(`Video ${videoId} not found`);
    const script = db.prepare('SELECT * FROM scripts WHERE id = ?').get(video.script_id);

    let evaluationBasis = 'metadata_and_script';
    let framesResult = { success: false };

    if (video.file_path) {
      framesResult = await extractFrames(video.file_path, 3);
      if (framesResult.success) evaluationBasis = 'video_frames';
      else this.log('warn', `Frame extraction failed, falling back to metadata-only critique`, { error: framesResult.error });
    }

    let prompt;
    if (evaluationBasis === 'video_frames') {
      prompt = [
        {
          role: 'system',
          content:
            'You are the Critic agent. You are given REAL frames extracted from the actual rendered video, ' +
            'plus its script/metadata. Evaluate hook strength, pacing, clarity, product relevance, CTA, ' +
            'visual quality, and retention potential based on what you actually see in the frames combined ' +
            'with the script. If the score is weak, suggest a concrete revision. Respond ONLY as JSON: ' +
            '{ score, feedback, visual_quality_notes, suggested_revision }.',
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: JSON.stringify({ video: { platform: video.platform, duration_seconds: video.duration_seconds }, script }) },
            ...framesResult.frames.map((b64) => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } })),
          ],
        },
      ];
    } else {
      prompt = [
        {
          role: 'system',
          content:
            'You are the Critic agent reviewing a produced video. IMPORTANT: you were NOT able to see the ' +
            'actual video frames (either it has not been rendered yet, or frame extraction failed) - you only ' +
            'have its script and metadata. Evaluate based on that alone, and do not claim to have seen the ' +
            'visuals. Score 0-100 for likely hook strength, clarity, appeal, CTA quality, product relevance, ' +
            'and retention potential. If the score is weak, suggest a concrete revision. Respond ONLY as JSON: ' +
            '{ score, feedback, suggested_revision }.',
        },
        { role: 'user', content: JSON.stringify({ video, script }) },
      ];
    }

    const raw = await this.think(prompt, {}, { videoId }).catch(async (err) => {
      if (evaluationBasis !== 'video_frames') throw err; // metadata path already the fallback, nothing left to try
      this.log('warn', 'Vision-based critique call failed (model may not support image input) - retrying metadata-only', {
        error: err.message,
      });
      evaluationBasis = 'metadata_and_script';
      const fallbackPrompt = [
        {
          role: 'system',
          content:
            'You are the Critic agent reviewing a produced video. IMPORTANT: an attempt to evaluate the ' +
            'actual video frames failed (model may not support image input), so you only have its script and ' +
            'metadata. Evaluate based on that alone, and do not claim to have seen the visuals. Score 0-100 ' +
            'for likely hook strength, clarity, appeal, CTA quality, product relevance, and retention ' +
            'potential. Respond ONLY as JSON: { score, feedback }.',
        },
        { role: 'user', content: JSON.stringify({ video, script }) },
      ];
      return this.think(fallbackPrompt, {}, { videoId });
    });
    const critique = JSON.parse(raw);

    const status = critique.score >= PASS_THRESHOLD ? 'ready_to_publish' : 'failed';
    db.prepare(
      `UPDATE videos SET status = ?, critic_rating = ?, critic_evaluation_basis = ?,
       critic_suggested_revision = ?, fail_reason = ? WHERE id = ?`
    ).run(
      status,
      critique.score,
      evaluationBasis,
      critique.suggested_revision || null,
      status === 'failed' ? critique.feedback : null,
      videoId
    );

    return { videoId, status, evaluationBasis, ...critique };
  }
}

module.exports = CriticAgent;
