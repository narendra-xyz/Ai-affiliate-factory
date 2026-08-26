// Content Agent - runs the REAL video render pipeline: script -> TTS ->
// visual -> subtitle -> FFmpeg composition -> MP4 + thumbnail. This is
// not a database-record-only placeholder; videoRenderer.service.js does
// genuine work with real external tools (espeak-ng/ffmpeg), each
// wrapped in an adapter with a clear "Not Configured" fallback.
const BaseAgent = require('./baseAgent');
const db = require('../config/db');
const { videoQueue } = require('../services/queue.service');
const { renderVideo } = require('../services/videoRenderer.service');

class ContentAgent extends BaseAgent {
  constructor() {
    super('content_agent', 'Content Agent');
  }

  async run(taskType, input) {
    if (taskType !== 'generate_video') throw new Error(`Unsupported task type: ${taskType}`);

    // videoId is optional: when present (e.g. from the retry endpoint),
    // the EXISTING video row is reused/updated instead of creating a
    // duplicate. Without it, a fresh video row is created as normal.
    const { scriptId, platform = 'tiktok', videoId: existingVideoId } = input || {};
    const script = db.prepare('SELECT * FROM scripts WHERE id = ?').get(scriptId);
    if (!script || script.status !== 'approved') {
      throw new Error(`Script ${scriptId} must be approved before video generation`);
    }
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(script.product_id);

    // Actual rendering is delegated to the video queue so FFmpeg
    // concurrency is capped regardless of how many requests come in.
    return videoQueue.push(async () => {
      let videoId;

      if (existingVideoId) {
        const existing = db.prepare('SELECT * FROM videos WHERE id = ?').get(existingVideoId);
        if (!existing) throw new Error(`Video ${existingVideoId} not found`);
        db.prepare(
          `UPDATE videos SET script_id = ?, product_id = ?, title = ?, platform = ?, status = 'draft', fail_reason = NULL WHERE id = ?`
        ).run(scriptId, script.product_id, script.hook, platform, existingVideoId);
        videoId = existingVideoId;
      } else {
        const videoRes = db
          .prepare(
            `INSERT INTO videos (script_id, product_id, title, agent_name, platform, status, storage_status)
             VALUES (?, ?, ?, 'content_agent', ?, 'draft', 'not_rendered')`
          )
          .run(scriptId, script.product_id, script.hook, platform);
        videoId = videoRes.lastInsertRowid;
      }

      this.log('info', `Rendering video for script ${scriptId}`, { videoId, platform });

      const result = await renderVideo({ script, product, videoId });

      if (!result.success) {
        db.prepare(`UPDATE videos SET status = 'failed', fail_reason = ? WHERE id = ?`).run(result.error, videoId);
        if (result.notConfigured) {
          const err = new Error(result.error);
          err.code = 'NOT_CONFIGURED';
          throw err;
        }
        throw new Error(result.error);
      }

      db.prepare(
        `UPDATE videos SET status = 'review', file_path = ?, thumbnail_path = ?, duration_seconds = ?,
         resolution = ?, storage_status = ? WHERE id = ?`
      ).run(result.filePath, result.thumbnailPath, result.durationSeconds, result.resolution, result.storageStatus, videoId);

      this.log('info', `Video rendered successfully`, { videoId, visualSource: result.visualSource, storageStatus: result.storageStatus });

      return {
        videoId,
        status: 'review',
        filePath: result.filePath,
        thumbnailPath: result.thumbnailPath,
        durationSeconds: result.durationSeconds,
        visualSource: result.visualSource,
      };
    });
  }
}

module.exports = ContentAgent;
