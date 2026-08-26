// Visual media adapter for the video's background/b-roll. Three real paths,
// tried in priority order:
//
// 1. Stock media provider (VISUAL_MEDIA_PROVIDER_URL) if configured - most
//    relevant b-roll, fetched via a real HTTP call.
// 2. Product image: if the product has a real image_url (from Product
//    Hunter's real data), it's downloaded and used as the background.
// 3. Text-card fallback: if neither above is available, FFmpeg generates
//    a real solid-color card with the product name/hook drawn as text via
//    the drawtext filter. This ALWAYS works with zero external
//    credentials - it's genuine FFmpeg output, not a placeholder image.
require('dotenv').config();
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function escapeForDrawtext(text) {
  return String(text || '')
    .replace(/\\/g, '\\\\\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, '\u2019')
    .slice(0, 120);
}

function runFfmpeg(args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', ['-y', ...args]);
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`ffmpeg timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-500)}`));
    });
  });
}

async function downloadImage(url, outputPath, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`Image download responded ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(outputPath, buffer);
    return true;
  } catch (err) {
    clearTimeout(timer);
    return false;
  }
}

async function fetchStockMedia({ query }) {
  if (!process.env.VISUAL_MEDIA_PROVIDER_URL) return { configured: false };
  try {
    const url = new URL(process.env.VISUAL_MEDIA_PROVIDER_URL);
    url.searchParams.set('query', query || '');
    const headers = { Accept: 'application/json' };
    if (process.env.VISUAL_MEDIA_PROVIDER_KEY) headers.Authorization = `Bearer ${process.env.VISUAL_MEDIA_PROVIDER_KEY}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(url.toString(), { headers, signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`Provider responded ${res.status}`);
    const data = await res.json();
    // Expected shape: { image_url: "..." } or { url: "..." } - adjust to
    // your actual stock-media provider's response shape if different.
    return { configured: true, imageUrl: data.image_url || data.url || null };
  } catch (err) {
    return { configured: true, imageUrl: null, error: err.message };
  }
}

/**
 * Builds a visual video clip (no audio) of `durationSeconds` for the
 * given product/hook, writing to `outputPath` (.mp4).
 * @returns {Promise<{source:'stock_media'|'product_image'|'generated_card', outputPath:string}>}
 */
async function buildVisualClip({ product, hook, durationSeconds, workDir }) {
  const width = 1080;
  const height = 1920; // vertical, short-form format

  // Priority 1: configured stock-media provider (most relevant b-roll).
  const stock = await fetchStockMedia({ query: product?.name || hook });
  if (stock.configured && stock.imageUrl) {
    const imgPath = path.join(workDir, 'stock_media.jpg');
    const downloaded = await downloadImage(stock.imageUrl, imgPath);
    if (downloaded) {
      const outputPath = path.join(workDir, 'visual.mp4');
      try {
        await runFfmpeg([
          '-loop', '1', '-i', imgPath,
          '-vf', `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},drawtext=text='${escapeForDrawtext(hook)}':fontcolor=white:fontsize=52:x=(w-text_w)/2:y=h-300:box=1:boxcolor=black@0.5:boxborderw=20`,
          '-t', String(durationSeconds), '-r', '30', '-pix_fmt', 'yuv420p', outputPath,
        ]);
        return { source: 'stock_media', outputPath };
      } catch (err) {
        // fall through to product image / generated card
      }
    }
  }

  // Priority 2: the product's own real image (from Product Hunter's data).
  if (product?.image_url_local || product?.image_url) {
    const imgPath = product.image_url_local || path.join(workDir, 'product_image.jpg');
    let haveImage = !!product.image_url_local;
    if (!haveImage && product.image_url) {
      haveImage = await downloadImage(product.image_url, imgPath);
    }
    if (haveImage) {
      const outputPath = path.join(workDir, 'visual.mp4');
      try {
        await runFfmpeg([
          '-loop', '1', '-i', imgPath,
          '-vf', `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},drawtext=text='${escapeForDrawtext(hook)}':fontcolor=white:fontsize=52:x=(w-text_w)/2:y=h-300:box=1:boxcolor=black@0.5:boxborderw=20`,
          '-t', String(durationSeconds),
          '-r', '30',
          '-pix_fmt', 'yuv420p',
          outputPath,
        ]);
        return { source: 'product_image', outputPath };
      } catch (err) {
        // fall through to generated card on any ffmpeg failure with the image
      }
    }
  }

  // Fallback: generated text card, zero external dependency.
  const outputPath = path.join(workDir, 'visual.mp4');
  const title = escapeForDrawtext(product?.name || 'Produk');
  const hookText = escapeForDrawtext(hook || '');

  await runFfmpeg([
    '-f', 'lavfi', '-i', `color=c=0x1a1f2e:s=${width}x${height}:d=${durationSeconds}`,
    '-vf',
    `drawtext=text='${title}':fontcolor=white:fontsize=64:x=(w-text_w)/2:y=(h-text_h)/2-100:box=1:boxcolor=0x5b8cff@0.9:boxborderw=24,` +
    `drawtext=text='${hookText}':fontcolor=white:fontsize=44:x=(w-text_w)/2:y=(h-text_h)/2+80`,
    '-r', '30',
    '-pix_fmt', 'yuv420p',
    outputPath,
  ]);

  return { source: 'generated_card', outputPath };
}

module.exports = { buildVisualClip, runFfmpeg };
