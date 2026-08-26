// Text-to-Speech adapter. Two real implementations, chosen via
// TTS_PROVIDER env var:
//
// - 'local_espeak' (default): shells out to espeak-ng, a lightweight,
//   free, offline speech synthesizer (apt-get install espeak-ng on the
//   VPS). No credentials needed, near-zero resource footprint - fits
//   the "prioritize free" and "don't run heavy AI locally" constraints
//   since espeak-ng is a small rule-based synthesizer, not a neural model.
// - 'external': calls a configured external TTS API (TTS_API_URL +
//   TTS_API_KEY), for when a more natural-sounding voice is wanted and
//   the operator has credentials for one.
//
// If neither is actually usable at call time, this returns a clear
// { configured: false, reason } instead of producing a silent/fake file.
require('dotenv').config();
const { spawn } = require('child_process');
const fs = require('fs');

function binaryAvailable(bin) {
  const { spawnSync } = require('child_process');
  try {
    return spawnSync('which', [bin]).status === 0;
  } catch (_) {
    return false;
  }
}

function getProvider() {
  return process.env.TTS_PROVIDER || 'local_espeak';
}

function isConfigured() {
  const provider = getProvider();
  if (provider === 'local_espeak') return binaryAvailable('espeak-ng');
  return !!(process.env.TTS_API_URL && process.env.TTS_API_KEY);
}

/**
 * Synthesizes speech for `text` and writes a WAV file to `outputPath`.
 * @returns {Promise<{configured:boolean, outputPath?:string, estimatedDurationSeconds?:number, error?:string}>}
 */
async function synthesizeSpeech(text, outputPath) {
  const provider = getProvider();

  if (provider === 'local_espeak') {
    if (!binaryAvailable('espeak-ng')) {
      return {
        configured: false,
        error: 'espeak-ng tidak ditemukan di sistem. Install dengan: apt-get install espeak-ng',
      };
    }
    return new Promise((resolve) => {
      // -v id: Indonesian voice, -s: speed (words/min), -w: write to WAV file
      const proc = spawn('espeak-ng', ['-v', process.env.TTS_LANG || 'id', '-s', '160', '-w', outputPath, text]);
      let stderr = '';
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        resolve({ configured: true, error: 'espeak-ng timed out after 30s' });
      }, 30000);

      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0 || !fs.existsSync(outputPath)) {
          resolve({ configured: true, error: `espeak-ng exited with code ${code}: ${stderr}` });
          return;
        }
        // Rough duration estimate from wav file size (16-bit mono, ~22050Hz
        // default for espeak-ng); refined later from ffprobe in the renderer.
        const stats = fs.statSync(outputPath);
        const estimatedDurationSeconds = stats.size / (22050 * 2);
        resolve({ configured: true, outputPath, estimatedDurationSeconds });
      });
    });
  }

  // external provider
  if (!process.env.TTS_API_URL || !process.env.TTS_API_KEY) {
    return { configured: false, error: 'TTS_API_URL/TTS_API_KEY belum diset untuk TTS_PROVIDER=external' };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    const res = await fetch(process.env.TTS_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.TTS_API_KEY}` },
      body: JSON.stringify({ text, voice: process.env.TTS_VOICE || 'default' }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`TTS API responded ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(outputPath, buffer);
    return { configured: true, outputPath };
  } catch (err) {
    return { configured: true, error: `External TTS call failed: ${err.message}` };
  }
}

module.exports = { synthesizeSpeech, isConfigured, getProvider };
