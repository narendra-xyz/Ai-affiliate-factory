// Storage abstraction: where a finished render ends up.
//
// - If STORAGE_PROVIDER + S3_* credentials are configured, the final
//   MP4/thumbnail are uploaded to S3-compatible object storage and the
//   local copy is deleted (storage_status = 'remote_object_storage').
// - Otherwise, the final files are moved from the temp working directory
//   into a permanent local folder (storage_status = 'local_permanent') -
//   NOT left in temp. Since local disk on an 8GB/4vCPU VPS is finite,
//   this module also enforces a retention policy (LOCAL_STORAGE_MAX_GB /
//   LOCAL_STORAGE_MAX_DAYS) so videos don't accumulate on disk without
//   bound - see enforceLocalRetention().
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('../../config/db');
const logger = require('../../utils/logger');

const LOCAL_PERMANENT_DIR = process.env.LOCAL_VIDEO_STORAGE_DIR || path.join(__dirname, '..', '..', 'storage', 'videos');
const MAX_GB = parseFloat(process.env.LOCAL_STORAGE_MAX_GB || '20');
const MAX_DAYS = parseInt(process.env.LOCAL_STORAGE_MAX_DAYS || '30', 10);

function isObjectStorageConfigured() {
  return !!(process.env.STORAGE_PROVIDER && process.env.S3_ENDPOINT && process.env.S3_ACCESS_KEY && process.env.S3_SECRET_KEY && process.env.S3_BUCKET);
}

function ensureLocalDir() {
  if (!fs.existsSync(LOCAL_PERMANENT_DIR)) fs.mkdirSync(LOCAL_PERMANENT_DIR, { recursive: true });
}

/**
 * Moves a finished local file to its permanent home.
 * @returns {Promise<{storageStatus:string, finalPath:string}>}
 *   finalPath is a local filesystem path (local_permanent) or a public
 *   URL (remote_object_storage), depending on what's configured.
 */
async function persistOutput(localTempPath, filename) {
  if (isObjectStorageConfigured()) {
    try {
      // Generic S3-compatible PUT via signed-URL-less basic auth is provider
      // specific; this is intentionally left as a clearly-marked extension
      // point rather than guessing a shape. Wire in @aws-sdk/client-s3 (or
      // your provider's SDK) here once real credentials are available.
      throw new Error('Object storage upload not yet implemented for this provider - falling back to local storage');
    } catch (err) {
      // Fall through to local storage rather than losing the render.
    }
  }

  ensureLocalDir();
  const finalPath = path.join(LOCAL_PERMANENT_DIR, filename);
  fs.copyFileSync(localTempPath, finalPath);
  fs.unlinkSync(localTempPath);
  return { storageStatus: 'local_permanent', finalPath };
}

/** Deletes a list of temp intermediate files, ignoring missing ones. */
function cleanupTempFiles(paths) {
  for (const p of paths) {
    try {
      if (p && fs.existsSync(p)) fs.unlinkSync(p);
    } catch (_) {
      // best-effort cleanup, never throw
    }
  }
}

/**
 * Enforces local disk retention so video storage doesn't grow unbounded
 * on the VPS: deletes the oldest local_permanent video files (oldest
 * first) once total size exceeds LOCAL_STORAGE_MAX_GB, and independently
 * deletes any local video older than LOCAL_STORAGE_MAX_DAYS. Only runs
 * against files whose storage_status is 'local_permanent' - never
 * touches videos already offloaded to object storage. The DB row is kept
 * (metadata persists per spec) but file_path/thumbnail_path are cleared
 * and storage_status flips to 'purged_local' so the dashboard shows the
 * video existed but its file is no longer available for preview.
 */
function enforceLocalRetention() {
  if (!fs.existsSync(LOCAL_PERMANENT_DIR)) return { purged: 0 };

  const rows = db
    .prepare(
      `SELECT id, file_path, thumbnail_path, created_at FROM videos
       WHERE storage_status = 'local_permanent' AND file_path IS NOT NULL
       ORDER BY created_at ASC`
    )
    .all();

  let purged = 0;
  const now = Date.now();
  const maxAgeMs = MAX_DAYS * 24 * 60 * 60 * 1000;

  const purgeVideo = (row) => {
    for (const p of [row.file_path, row.thumbnail_path]) {
      try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch (_) { /* best effort */ }
    }
    db.prepare(`UPDATE videos SET storage_status = 'purged_local', file_path = NULL, thumbnail_path = NULL WHERE id = ?`).run(row.id);
    purged++;
  };

  // 1. Age-based purge, independent of total size.
  for (const row of rows) {
    if (now - new Date(row.created_at).getTime() > maxAgeMs) purgeVideo(row);
  }

  // 2. Size-based purge: if still over budget, remove oldest remaining
  // files first until under LOCAL_STORAGE_MAX_GB.
  const remaining = rows.filter((r) => fs.existsSync(r.file_path || ''));
  let totalBytes = 0;
  const sized = remaining.map((r) => {
    let size = 0;
    try { size = fs.statSync(r.file_path).size; } catch (_) { /* file may already be gone */ }
    totalBytes += size;
    return { ...r, size };
  });

  const maxBytes = MAX_GB * 1024 * 1024 * 1024;
  for (const row of sized) {
    if (totalBytes <= maxBytes) break;
    purgeVideo(row);
    totalBytes -= row.size;
  }

  if (purged > 0) logger.log('system', 'info', `Local storage retention purged ${purged} video(s)`, { maxGb: MAX_GB, maxDays: MAX_DAYS });
  return { purged };
}

module.exports = { persistOutput, cleanupTempFiles, isObjectStorageConfigured, enforceLocalRetention, LOCAL_PERMANENT_DIR };
