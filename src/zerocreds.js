// ZeroCreds session API client (issue #53).
//
// ZeroCreds is our own repo (github.com/Zerocreds-com/zerocreds-server), deployed at
// ZEROCREDS_BASE_URL (zerocreds.ru → RU VM, nginx proxies /api/* and /f/*). The worker
// creates a session, hands the user its form URL, and later receives the submitted keys
// on /internal/creds — the admin token never leaves the worker.

// ZeroCreds probes an http_post destination BEFORE rendering the form (testDestination →
// saveHttpPost with X-ZeroCreds-Preflight). The probe carries no user data; answering it
// with a write would store `{"_zerocreds_preflight": true}` as a credential. Port of the
// helper trained-assist-agent grew after the duplicate-notify incident of 2026-09-24.
export function isPreflight(payload, headers) {
  if (payload && payload._zerocreds_preflight === true) return true;
  if (String((headers && headers['x-zerocreds-preflight']) || '').toLowerCase() === 'true') return true;
  const v = payload && payload.value;
  if (v && typeof v === 'object' && v._zerocreds_preflight === true) return true;
  if (typeof v === 'string' && v.includes('_zerocreds_preflight')) {
    try { return JSON.parse(v)?._zerocreds_preflight === true; } catch { return false; }
  }
  return false;
}

// Destination is passed INLINE at session/create, which is what makes correlation possible:
// http_post templates only interpolate form fields (applyTemplate(dest.url, fields)), so
// ZeroCreds cannot echo a session id back — but since we build the destination per call,
// WE can bake our own ids into the URL.
export function buildDestination({ origin, uid, sid, provider, webhookToken }) {
  const url = `${origin}/internal/creds?uid=${encodeURIComponent(uid)}`
    + `&sid=${encodeURIComponent(sid)}&provider=${encodeURIComponent(provider)}`;
  return { type: 'http_post', url, headers: { Authorization: `Bearer ${webhookToken}` } };
}

// POST /api/session/create → { token, url, expires_at }.
export async function createSession({ baseUrl, adminToken, title, description, fields, destination, ttlMinutes = 30, fetchImpl = fetch }) {
  const resp = await fetchImpl(`${String(baseUrl).replace(/\/+$/, '')}/api/session/create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ title, description, fields, destination, ttl_minutes: ttlMinutes }),
  });
  if (!resp.ok) throw new Error(`zerocreds create: HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  return resp.json();
}

// GET /api/session/{token}/status → { status: pending | done | expired }.
export async function sessionStatus({ baseUrl, adminToken, token, fetchImpl = fetch }) {
  const resp = await fetchImpl(`${String(baseUrl).replace(/\/+$/, '')}/api/session/${encodeURIComponent(token)}/status`, {
    headers: { authorization: `Bearer ${adminToken}` },
  });
  if (resp.status === 404) return { status: 'expired' };
  if (!resp.ok) throw new Error(`zerocreds status: HTTP ${resp.status}`);
  return resp.json();
}
