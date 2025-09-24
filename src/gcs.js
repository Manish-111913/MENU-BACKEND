require('dotenv').config();
const path = require('path');
let Storage = null;
try {
  // Lazy require so app can still run without GCS
  ({ Storage } = require('@google-cloud/storage'));
} catch {
  // Optional dependency until installed
}

const IMAGE_CDN_BASE = process.env.IMAGE_CDN_BASE || null;
const GCS_BUCKET = process.env.GCS_BUCKET || null;
const HAS_GCS = !!(GCS_BUCKET && Storage);

function normalizeCredsPath(p) {
  if (!p) return null;
  // Expand quotes and normalize for Windows with spaces
  const cleaned = p.replace(/^"|"$/g, '');
  return path.normalize(cleaned);
}

// Returns a publicly accessible URL for an object in the bucket.
// If IMAGE_CDN_BASE is set, it will use that, otherwise the standard storage URL.
function publicUrl(objectPath) {
  if (!objectPath) return null;
  const base = IMAGE_CDN_BASE || (GCS_BUCKET ? `https://storage.googleapis.com/${GCS_BUCKET}` : null);
  if (!base) return objectPath; // Fall back to whatever was stored in DB
  // If objectPath already looks like a full URL, return as-is
  if (/^https?:\/\//i.test(objectPath)) return objectPath;
  return `${base}/${encodeURI(objectPath.replace(/^\//, ''))}`;
}

// Optionally create a signed URL if the bucket/object isn't public
async function signedUrl(objectPath, options = {}) {
  if (!HAS_GCS) return publicUrl(objectPath);
  if (!objectPath) return null;
  // If already a full URL, return it
  if (/^https?:\/\//i.test(objectPath)) return objectPath;

  // Ensure GOOGLE_APPLICATION_CREDENTIALS path is normalized (for Windows with spaces)
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = normalizeCredsPath(process.env.GOOGLE_APPLICATION_CREDENTIALS);
  }

  const storage = new Storage();
  const bucket = storage.bucket(GCS_BUCKET);
  const file = bucket.file(objectPath.replace(/^\//, ''));
  const [exists] = await file.exists();
  if (!exists) return publicUrl(objectPath);

  const expiresInMinutes = options.expiresInMinutes || 60; // 1 hour default
  const [url] = await file.getSignedUrl({ action: 'read', expires: Date.now() + expiresInMinutes * 60 * 1000 });
  return url;
}

module.exports = { publicUrl, signedUrl, HAS_GCS };
