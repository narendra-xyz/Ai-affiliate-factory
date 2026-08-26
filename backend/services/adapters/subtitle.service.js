// Generates a real .srt subtitle file from the script text, timed
// proportionally across the actual TTS audio duration. This is a
// genuine (if simple) implementation - not a mock - since word-level
// timestamps aren't available from espeak-ng without extra tooling;
// proportional-by-character-count timing is an honest, commonly used
// approximation until a provider with real timestamps is configured.
const fs = require('fs');

function formatSrtTime(seconds) {
  const ms = Math.round((seconds % 1) * 1000);
  const totalSeconds = Math.floor(seconds);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

function splitIntoSentences(text) {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * @param {string} fullText - hook + body + cta concatenated
 * @param {number} durationSeconds - real audio duration
 * @param {string} outputPath - .srt output path
 */
function generateSrt(fullText, durationSeconds, outputPath) {
  const sentences = splitIntoSentences(fullText);
  if (sentences.length === 0) {
    fs.writeFileSync(outputPath, '');
    return { outputPath, cues: 0 };
  }

  const totalChars = sentences.reduce((sum, s) => sum + s.length, 0) || 1;
  let cursor = 0;
  const lines = [];

  sentences.forEach((sentence, i) => {
    const share = sentence.length / totalChars;
    const dur = Math.max(0.8, share * durationSeconds);
    const start = cursor;
    const end = Math.min(durationSeconds, cursor + dur);
    cursor = end;

    lines.push(String(i + 1));
    lines.push(`${formatSrtTime(start)} --> ${formatSrtTime(end)}`);
    lines.push(sentence);
    lines.push('');
  });

  fs.writeFileSync(outputPath, lines.join('\n'));
  return { outputPath, cues: sentences.length };
}

module.exports = { generateSrt };
