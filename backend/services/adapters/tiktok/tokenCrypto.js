// Encrypts/decrypts TikTok access/refresh tokens at rest using
// AES-256-GCM (Node's built-in crypto module - no new dependency needed).
// Key comes from TIKTOK_TOKEN_ENCRYPTION_KEY (32-byte, hex-encoded).
// Tokens are NEVER stored or logged in plaintext anywhere in this system.
require('dotenv').config();
const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';

function getKey() {
  const hex = process.env.TIKTOK_TOKEN_ENCRYPTION_KEY;
  if (!hex) {
    const err = new Error(
      'NOT_CONFIGURED: TIKTOK_TOKEN_ENCRYPTION_KEY belum diset. Generate dengan: ' +
      'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
    err.code = 'NOT_CONFIGURED';
    throw err;
  }
  const key = Buffer.from(hex, 'hex');
  if (key.length !== 32) {
    throw new Error('TIKTOK_TOKEN_ENCRYPTION_KEY harus 32 byte (64 karakter hex).');
  }
  return key;
}

/** @returns {string} base64 blob containing iv + authTag + ciphertext */
function encrypt(plaintext) {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

/** @returns {string} original plaintext */
function decrypt(blob) {
  const key = getKey();
  const buf = Buffer.from(blob, 'base64');
  const iv = buf.subarray(0, 12);
  const authTag = buf.subarray(12, 28);
  const encrypted = buf.subarray(28);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

function isConfigured() {
  return !!process.env.TIKTOK_TOKEN_ENCRYPTION_KEY;
}

module.exports = { encrypt, decrypt, isConfigured };
