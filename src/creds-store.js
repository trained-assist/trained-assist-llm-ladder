// Encrypted credential storage for user-submitted API keys (issue #53).
//
// ZeroCreds collects the keys and POSTs them to /internal/creds; this module turns
// {provider, keys[], created_ms} into an opaque blob before it touches KV. KV itself is
// encrypted at rest by Cloudflare — the app-level AES-GCM is what stops a KV dump,
// dashboard read or accidental log line from handing out live API keys.
//
// Blob format: "v1.<iv_b64>.<ct_b64>" — the version prefix is what lets us rotate
// CREDS_ENC_KEY later (decrypt with the new key, re-encrypt, rewrite) without guessing
// which key a record was written with.

const IV_BYTES = 12; // AES-GCM standard nonce size
const KEY_BYTES = 32; // AES-256

// CREDS_ENC_KEY is a worker secret: base64 (URL-safe accepted) or hex, 32 bytes decoded.
export function parseEncKey(raw) {
  const s = String(raw || '').trim();
  if (!s) throw new Error('CREDS_ENC_KEY is not set');
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  let bytes = null;
  if (/^[0-9a-fA-F]{64}$/.test(s)) {
    bytes = new Uint8Array(KEY_BYTES);
    for (let i = 0; i < KEY_BYTES; i++) bytes[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  } else {
    try {
      const bin = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '='));
      bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
    } catch {
      throw new Error('CREDS_ENC_KEY is not valid base64 or hex');
    }
  }
  if (bytes.length !== KEY_BYTES) throw new Error(`CREDS_ENC_KEY must decode to ${KEY_BYTES} bytes, got ${bytes.length}`);
  return bytes;
}

async function importKey(keyBytes) {
  return crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0));

// value: anything JSON-serialisable. Returns the stored string, never the plaintext.
export async function encryptValue(keyBytes, value) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await importKey(keyBytes);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(value)));
  return `v1.${b64(iv)}.${b64(ct)}`;
}

// Inverse of encryptValue. Rejects an unknown version rather than guessing — a record
// written by a future format must not be half-decrypted here.
export async function decryptValue(keyBytes, blob) {
  const [v, iv, ct] = String(blob || '').split('.');
  if (v !== 'v1' || !iv || !ct) throw new Error('unknown creds blob format');
  const key = await importKey(keyBytes);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, key, unb64(ct));
  return JSON.parse(new TextDecoder().decode(pt));
}

// uid: the 128-bit landing capability (hex). sid: the per-session id WE mint at
// /connect time and bake into the ZeroCreds destination URL — ZeroCreds only templates
// form fields into http_post URLs, so it cannot echo a session id back to us.
export function credsKey(uid, sid) {
  return `creds:${uid}:${sid}`;
}

export function sessionKey(sid) {
  return `sess:${sid}`;
}

const UID_RE = /^[0-9a-f]{32}$/;
const SID_RE = /^[0-9a-f]{32}$/;
export const validUid = (uid) => UID_RE.test(String(uid || ''));
export const validSid = (sid) => SID_RE.test(String(sid || ''));

// Up to 5 slots per submission (owner: «сделай чтобы можно было 5 штук вводить»).
export const MAX_KEYS = 5;

export function collectKeys(fields) {
  const keys = [];
  for (let i = 1; i <= MAX_KEYS; i++) {
    const v = String((fields && fields[`key${i}`]) || '').trim();
    if (v) keys.push(v);
  }
  return keys;
}

// Append-only: one blob per session, so a later submission never clobbers an earlier one
// and a uid can hold several providers. Listing by prefix is how BYOK reads them later.
export async function putCreds(kv, keyBytes, { uid, sid, provider, keys, createdMs }) {
  const blob = await encryptValue(keyBytes, { uid, sid, provider, keys, created_ms: createdMs || Date.now() });
  await kv.put(credsKey(uid, sid), blob);
  return { uid, sid, provider, count: keys.length };
}

export async function putSessionMeta(kv, sid, meta) {
  await kv.put(sessionKey(sid), JSON.stringify(meta));
}

export async function getSessionMeta(kv, sid) {
  const raw = await kv.get(sessionKey(sid));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// Decrypts every blob of one uid and returns metadata only (provider, count, timestamps) —
// the keys themselves never leave this function's caller-facing shape. A corrupt blob is
// skipped rather than failing the whole listing: one bad record must not hide the rest.
export async function listCredsMeta(kv, keyBytes, uid) {
  const out = [];
  let cursor;
  do {
    const page = await kv.list({ prefix: `creds:${uid}:`, cursor, limit: 100 });
    for (const { name } of page.keys || []) {
      const raw = await kv.get(name);
      if (!raw) continue;
      try {
        const v = await decryptValue(keyBytes, raw);
        out.push({
          sid: v.sid || name.slice(`creds:${uid}:`.length),
          provider: v.provider || null,
          count: Array.isArray(v.keys) ? v.keys.length : 0,
          created_ms: v.created_ms || null,
        });
      } catch { /* skip unreadable record */ }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out.sort((a, b) => (b.created_ms || 0) - (a.created_ms || 0));
}
