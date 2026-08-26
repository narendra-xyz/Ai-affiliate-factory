// Extracts a handful of real frames from a rendered video as base64 JPEGs,
// so Critic Agent can genuinely look at the video (if the configured AI
// model supports image input) instead of only reasoning from text.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

function runFfmpeg(args, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', ['-y', ...args]);
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('ffmpeg frame extraction timed out')); }, timeoutMs);
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-300)}`));
    });
  });
}

/**
 * @returns {Promise<{success:boolean, frames?:string[] (base64 jpeg), error?:string}>}
 */
async function extractFrames(videoPath, count = 3) {
  if (!videoPath || !fs.existsSync(videoPath)) {
    return { success: false, error: 'Video file not found on disk' };
  }
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aaf-frames-'));
  try {
    const pattern = path.join(workDir, 'frame_%02d.jpg');
    // Grab `count` frames evenly spaced (fps filter based on a rough guess;
    // good enough for a quick visual sanity check, not a precision tool).
    await runFfmpeg(['-i', videoPath, '-vf', `fps=1/2`, '-frames:v', String(count), pattern]);

    const files = fs.readdirSync(workDir).filter((f) => f.startsWith('frame_')).sort();
    if (files.length === 0) return { success: false, error: 'No frames extracted' };

    const frames = files.map((f) => fs.readFileSync(path.join(workDir, f)).toString('base64'));
    return { success: true, frames };
  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    try {
      for (const f of fs.readdirSync(workDir)) fs.unlinkSync(path.join(workDir, f));
      fs.rmdirSync(workDir);
    } catch (_) { /* best effort cleanup */ }
  }
}

module.exports = { extractFrames };
