// Public connect flow: landing → ZeroCreds form → webhook back into encrypted KV (#53).
//
// Everything here runs BEFORE the LADDER_TOKEN gate in handler.js — these are the only
// routes a browser hits without the ladder token. The gate still covers /v1/*.

import {
  parseEncKey, putCreds, putSessionMeta, getSessionMeta, listCredsMeta,
  collectKeys, validUid, validSid, MAX_KEYS,
} from './creds-store.js';
import { isPreflight, buildDestination, createSession, sessionStatus } from './zerocreds.js';
import { landingHtml } from './landing.js';
import providers from '../config/providers.json' with { type: 'json' };

const UID_COOKIE = 'ladder_uid';

const LANDING_RE = /^\/u\/([0-9a-f]{32})$/;
const CONNECT_RE = /^\/u\/([0-9a-f]{32})\/connect$/;
const STATUS_RE = /^\/u\/([0-9a-f]{32})\/status\/([0-9a-f]{32})$/;

const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});
const html = (status, body) => new Response(body, {
  status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
});
const redirect = (location, headers = {}) => new Response(null, { status: 302, headers: { location, ...headers } });

function timingSafeEqual(a, b) {
  const x = new TextEncoder().encode(String(a));
  const y = new TextEncoder().encode(String(b));
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

// uid and sid are both 128-bit random hex: the uid is the capability for one bucket, the
// sid is the per-session id WE mint (ZeroCreds cannot echo one back — http_post templates
// only interpolate form fields).
export function mintId() {
  return [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
}

function cookieUid(request) {
  const raw = request.headers.get('cookie') || '';
  const m = new RegExp(`(?:^|;\\s*)${UID_COOKIE}=([0-9a-f]{32})(?:;|$)`).exec(raw);
  return m ? m[1] : null;
}

function setUidCookie(uid) {
  return `${UID_COOKIE}=${uid}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`;
}

// Reads the landing POST as either urlencoded (a plain <form>) or JSON (a fetch).
async function readBody(request) {
  const ct = String(request.headers.get('content-type') || '');
  if (ct.includes('application/json')) {
    try { return (await request.json()) || {}; } catch { return null; }
  }
  const params = new URLSearchParams(await request.text());
  return Object.fromEntries(params);
}

function kv(env) {
  return env.LADDER_CREDS || null;
}

function misconfigured(what) {
  return json(503, { error: `connect flow not configured: ${what}` });
}

export async function handleLanding(request, env, { fetchImpl = fetch } = {}) {
  const url = new URL(request.url);

  if (request.method === 'GET' && url.pathname === '/') {
    const existing = cookieUid(request);
    const uid = existing && validUid(existing) ? existing : mintId();
    const headers = existing === uid ? {} : { 'set-cookie': setUidCookie(uid) };
    return redirect(`${url.origin}/u/${uid}`, headers);
  }

  if (request.method === 'GET' && url.pathname === '/favicon.ico') return new Response(null, { status: 204 });

  const landing = LANDING_RE.exec(url.pathname);
  if (landing && request.method === 'GET') {
    const uid = landing[1];
    const headers = cookieUid(request) === uid ? {} : { 'set-cookie': setUidCookie(uid) };
    const status = url.searchParams.get('status');
    const error = url.searchParams.get('error');
    return new Response(landingHtml(uid, providers, { baseUrl: url.origin, status, error }), {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers },
    });
  }

  const connect = CONNECT_RE.exec(url.pathname);
  if (connect && request.method === 'POST') return handleConnect(request, env, connect[1], { fetchImpl });

  const statusRoute = STATUS_RE.exec(url.pathname);
  if (statusRoute && request.method === 'GET') return handleStatus(env, statusRoute[1], statusRoute[2], { fetchImpl });

  return null;
}

async function handleConnect(request, env, uid, { fetchImpl }) {
  if (!validUid(uid)) return json(400, { error: 'bad uid' });
  if (!env.ZC_WEBHOOK_TOKEN) return misconfigured('ZC_WEBHOOK_TOKEN');
  if (!kv(env)) return misconfigured('LADDER_CREDS');

  const body = await readBody(request);
  if (!body) return json(400, { error: 'bad body' });
  const provider = String(body.provider || '').trim();
  const spec = providers[provider];
  if (!spec) return json(400, { error: 'unknown provider', allowed: Object.keys(providers) });

  const origin = new URL(request.url).origin;
  const sid = mintId();
  const destination = buildDestination({ origin, uid, sid, provider, webhookToken: env.ZC_WEBHOOK_TOKEN });

  // key1 is required by ZeroCreds; key2..key5 optional — the owner wants up to five slots
  // per submission so a user can paste several keys of the same provider at once.
  const fields = Array.from({ length: MAX_KEYS }, (_, i) => ({
    name: `key${i + 1}`,
    label: i === 0 ? 'Ключ' : `Ключ ${i + 1}`,
    type: 'password',
    required: i === 0,
    placeholder: i === 0 ? 'Вставьте ключ' : 'Ещё один ключ (необязательно)',
  }));

  let session;
  try {
    session = await createSession({
      baseUrl: env.ZEROCREDS_BASE_URL || 'https://zerocreds.ru',
      adminToken: env.ZEROCREDS_ADMIN_TOKEN,
      title: `Подключить ${spec.label}`,
      description: `${spec.hint} Куда идти за ключом: ${spec.where}.`,
      fields,
      destination,
      ttlMinutes: 30,
      fetchImpl,
    });
  } catch (e) {
    console.log(JSON.stringify({ event: 'connect_failed', provider, uid, error: e.message }));
    return json(502, { error: 'zerocreds unavailable' });
  }

  await putSessionMeta(kv(env), sid, {
    uid, provider, zc: session.token, created_ms: Date.now(),
  });

  // 302 keeps the plain <form> on the landing working with no JS; a fetch() caller reads
  // the Location header instead.
  if (String(request.headers.get('accept') || '').includes('application/json')) {
    return json(200, { sid, url: session.url, expires_at: session.expires_at || null });
  }
  return redirect(session.url);
}

async function handleStatus(env, uid, sid, { fetchImpl }) {
  if (!validUid(uid) || !validSid(sid)) return json(400, { error: 'bad id' });
  if (!kv(env)) return misconfigured('LADDER_CREDS');
  const meta = await getSessionMeta(kv(env), sid);
  if (!meta || meta.uid !== uid) return json(404, { error: 'unknown session' });
  try {
    const s = await sessionStatus({
      baseUrl: env.ZEROCREDS_BASE_URL || 'https://zerocreds.ru',
      adminToken: env.ZEROCREDS_ADMIN_TOKEN,
      token: meta.zc,
      fetchImpl,
    });
    const saved = s.status === 'done' ? await listCredsMeta(kv(env), parseEncKey(env.CREDS_ENC_KEY), uid) : [];
    return json(200, { status: s.status, provider: meta.provider || null, saved });
  } catch (e) {
    return json(502, { error: 'zerocreds unavailable', detail: e.message });
  }
}

// ZeroCreds POSTs here. Two cases share one route: the pre-flight reachability probe
// (answer 200, write nothing) and the real submission.
export async function handleWebhook(request, env) {
  if (request.method !== 'POST') return null;
  if (new URL(request.url).pathname !== '/internal/creds') return null;

  if (!env.ZC_WEBHOOK_TOKEN) return misconfigured('ZC_WEBHOOK_TOKEN');
  const auth = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') || '');
  if (!auth || !timingSafeEqual(auth[1].trim(), env.ZC_WEBHOOK_TOKEN)) return json(401, { error: 'unauthorized' });
  if (!kv(env)) return misconfigured('LADDER_CREDS');

  let payload = null;
  try { payload = await request.json(); } catch { payload = null; }

  if (isPreflight(payload, request.headers)) return json(200, { ok: true, preflight: true });

  const url = new URL(request.url);
  const uid = url.searchParams.get('uid') || '';
  const sid = url.searchParams.get('sid') || '';
  const provider = url.searchParams.get('provider') || '';
  if (!validUid(uid) || !validSid(sid)) return json(400, { error: 'bad id' });
  if (!providers[provider]) return json(400, { error: 'unknown provider' });

  // Only accept a sid we minted ourselves at /connect — an arbitrary POST cannot plant
  // keys in a bucket it never opened.
  const meta = await getSessionMeta(kv(env), sid);
  if (!meta || meta.uid !== uid || meta.provider !== provider) return json(404, { error: 'unknown session' });

  const keys = collectKeys(payload);
  if (!keys.length) return json(400, { error: 'no keys submitted' });

  let keyBytes;
  try { keyBytes = parseEncKey(env.CREDS_ENC_KEY); } catch (e) {
    console.log(JSON.stringify({ event: 'creds_key_error', error: e.message }));
    return json(503, { error: 'credential storage not configured' });
  }

  try {
    const saved = await putCreds(kv(env), keyBytes, { uid, sid, provider, keys, createdMs: Date.now() });
    // One line per successful ingestion, never the values.
    console.log(JSON.stringify({ event: 'creds_saved', uid, sid, provider, count: saved.count }));
    return json(200, { ok: true, provider, count: saved.count });
  } catch (e) {
    console.log(JSON.stringify({ event: 'creds_save_failed', uid, sid, error: e.message }));
    return json(500, { error: 'store failed' });
  }
}
