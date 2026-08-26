// Real video render pipeline: script -> TTS -> visual -> subtitle burn ->
// FFmpeg composition -> MP4 + thumbnail. This is the actual
// implementation behind Content Agent - not a database-record-only
// placeholder. Every step produces a real file; failures at any step
// are surfaced with a specific, actionable reason (never silently
// swallowed into a fake "success").
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const { synthesizeSpeech } = require('./adapters/tts.adapter');
const { buildVisualClip } = require('./adapters/visual.adapter');
const { generateSrt } = require('./adapters/subtitle.service');
const { persistOutput, cleanupTempFiles } = require('./adapters/storage.adapter');

const RENDER_TIMEOUT_MS = parseInt(process.env.RENDER_TIMEOUT_MS || '180000', 10); // 3 min hard cap per video

function runFfmpeg(args, timeoutMs = RENDER_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', ['-y', ...args]);
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`ffmpeg render timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-800)}`));
    });
  });
}

function probeDuration(filePath) {
  return new Promise((resolve) => {
    const proc = spawn('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath,
    ]);
    let out = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.on('close', () => resolve(parseFloat(out.trim()) || null));
    proc.on('error', () => resolve(null));
  });
}

/**
 * Renders one video end-to-end for a given script + product.
 * @returns {Promise<{success:boolean, filePath?, thumbnailPath?, durationSeconds?, resolution?, storageStatus?, visualSource?, error?}>}
 */
async function renderVideo({ script, product, videoId }) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `aaf-render-${videoId}-`));
  const tempFiles = [];

  try {
    const fullText = [script.hook, script.body, script.cta].filter(Boolean).join(' ');
    const voicePath = path.join(workDir, 'voice.wav');
    tempFiles.push(voicePath);

    const tts = await synthesizeSpeech(fullText, voicePath);
    if (!tts.configured) {
      return { success: false, error: `NOT_CONFIGURED: ${tts.error}`, notConfigured: true };
    }
    if (tts.error) {
      return { success: false, error: `TTS gagal: ${tts.error}` };
    }

    const realDuration = (await probeDuration(voicePath)) || tts.estimatedDurationSeconds || 15;
    const durationSeconds = Math.max(5, Math.min(90, realDuration)); // sane bounds for short-form content

    const visual = await buildVisualClip({ product, hook: script.hook, durationSeconds, workDir });
    tempFiles.push(visual.outputPath);

    const srtPath = path.join(workDir, 'subtitle.srt');
    tempFiles.push(srtPath);
    generateSrt(fullText, durationSeconds, srtPath);

    const composedPath = path.join(workDir, 'composed.mp4');
    tempFiles.push(composedPath);

    // Escape path for ffmpeg's subtitles filter (colons and backslashes need escaping)
    const escapedSrtPath = srtPath.replace(/\\/g, '\\\\').replace(/:/g, '\\:');

    await runFfmpeg([
      '-i', visual.outputPath,
      '-i', voicePath,
      '-vf', `subtitles='${escapedSrtPath}':force_style='FontSize=18,PrimaryColour=&HFFFFFF&,OutlineColour=&H000000&,BorderStyle=3'`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-c:a', 'aac', '-b:a', '128k',
      '-shortest',
      composedPath,
    ]);

    const thumbPath = path.join(workDir, 'thumbnail.jpg');
    tempFiles.push(thumbPath);
    await runFfmpeg(['-i', composedPath, '-ss', '00:00:01', '-vframes', '1', thumbPath], 30000);

    const finalName = `video_${videoId}_${Date.now()}.mp4`;
    const thumbName = `thumb_${videoId}_${Date.now()}.jpg`;

    const videoPersist = await persistOutput(composedPath, finalName);
    const thumbPersist = await persistOutput(thumbPath, thumbName);

    // Clean up everything else still in the temp working directory.
    cleanupTempFiles(tempFiles.filter((f) => f !== composedPath && f !== thumbPath));
    try { fs.rmdirSync(workDir); } catch (_) { /* best effort */ }

    return {
      success: true,
      filePath: videoPersist.finalPath,
      thumbnailPath: thumbPersist.finalPath,
      durationSeconds: Math.round(durationSeconds * 10) / 10,
      resolution: '1080x1920',
      storageStatus: videoPersist.storageStatus,
      visualSource: visual.source,
    };
  } catch (err) {
    cleanupTempFiles(tempFiles);
    try { fs.rmdirSync(workDir); } catch (_) { /* best effort */ }
    return { success: false, error: err.message };
  }
}

module.exports = { renderVideo };
