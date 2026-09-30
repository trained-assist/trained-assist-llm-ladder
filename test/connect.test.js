import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/handler.js';
import {
  parseEncKey, encryptValue, decryptValue, collectKeys, validUid, validSid,
  credsKey, listCredsMeta, MAX_KEYS,
} from '../src/creds-store.js';
import { isPreflight, buildDestination } from '../src/zerocreds.js';

const UID = 'ab'.repeat(16);
const ENC_KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString('base64');

function fakeKV() {
  const m = new Map();
  return {
    _m: m,
    put: async (k, v) => { m.set(k, v); },
    get: async (k) => (m.has(k) ? m.get(k) : null),
    list: async ({ prefix = '', limit = 100 } = {}) => ({
      keys: [...m.keys()].filter(k => k.startsWith(prefix)).sort().slice(0, limit).map(name => ({ name })),
      list_complete: true,
    }),
  };
}

function fakeZeroCreds({ status = 'done', fail = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (fail) return new Response('nope', { status: 500 });
    if (String(url).includes('/api/session/create')) {
      return new Response(JSON.stringify({ token: 'zc_tok', url: 'https://zc.test/f/zc_tok' }), { status: 200 });
    }
    if (String(url).includes('/api/session/')) {
      return new Response(JSON.stringify({ status }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  };
  return { calls, fetchImpl };
}

function env(extra = {}) {
  return {
    LADDER_TOKEN: 't',
    LADDER_CREDS: fakeKV(),
    ZEROCREDS_BASE_URL: 'https://zc.test',
    ZEROCREDS_ADMIN_TOKEN: 'admin',
    ZC_WEBHOOK_TOKEN: 'whsec',
    CREDS_ENC_KEY: ENC_KEY,
    ...extra,
  };
}

const get = (e, path, opts = {}, extra = {}) =>
  handle(new Request(`https://l.test${path}`, opts), e, extra);
const post = (e, path, body, headers = {}, extra = {}) =>
  handle(new Request(`https://l.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }), e, extra);

// ── creds-store ───────────────────────────────────────────────────────────────

test('parseEncKey accepts base64 and hex, rejects bad material', () => {
  assert.equal(parseEncKey(ENC_KEY).length, 32);
  assert.equal(parseEncKey('aa'.repeat(32)).length, 32);
  assert.throws(() => parseEncKey(''), /not set/);
  assert.throws(() => parseEncKey('short'), /32 bytes|base64/);
  assert.throws(() => parseEncKey('!!! not base64 !!!'), /32 bytes|base64/);
});

test('encrypt/decrypt round-trips and never stores plaintext', async () => {
  const key = parseEncKey(ENC_KEY);
  const value = { uid: UID, sid: 'cd'.repeat(16), provider: 'openrouter', keys: ['sk-secret-1'] };
  const blob = await encryptValue(key, value);
  assert.match(blob, /^v1\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/);
  assert.ok(!blob.includes('sk-secret-1'), 'plaintext key leaked into the blob');
  assert.deepEqual(await decryptValue(key, blob), value);
});

test('decrypt rejects tampering and unknown versions', async () => {
  const key = parseEncKey(ENC_KEY);
  const other = parseEncKey(Buffer.from(Array(32).fill(9)).toString('base64'));
  const blob = await encryptValue(key, { keys: ['k'] });
  await assert.rejects(() => decryptValue(other, blob));
  const [v, iv, ct] = blob.split('.');
  await assert.rejects(() => decryptValue(key, `v9.${iv}.${ct}`), /unknown creds blob format/);
  await assert.rejects(() => decryptValue(key, `${v}.${iv}.${ct.slice(0, -4)}`));
});

test('collectKeys drops empty slots, caps at the form width', () => {
  assert.deepEqual(collectKeys({ key1: ' a ', key2: '', key3: 'b' }), ['a', 'b']);
  assert.deepEqual(collectKeys({}), []);
  const full = Object.fromEntries(Array.from({ length: MAX_KEYS + 2 }, (_, i) => [`key${i + 1}`, `k${i}`]));
  assert.equal(collectKeys(full).length, MAX_KEYS);
});

test('id validators are strict', () => {
  assert.ok(validUid(UID));
  assert.ok(!validUid('AB'.repeat(16)), 'uppercase must not pass');
  assert.ok(!validUid(UID.slice(0, 31)));
  assert.ok(!validUid(`g${UID.slice(1)}`));
  assert.ok(validSid('cd'.repeat(16)));
  assert.ok(!validSid('../etc/passwd'));
  assert.equal(credsKey(UID, 'cd'.repeat(16)), `creds:${UID}:${'cd'.repeat(16)}`);
});

// ── zerocreds helpers ─────────────────────────────────────────────────────────

test('isPreflight catches every probe shape', () => {
  assert.ok(isPreflight({ _zerocreds_preflight: true }, {}));
  assert.ok(isPreflight({}, { 'x-zerocreds-preflight': 'true' }));
  assert.ok(isPreflight({ value: { _zerocreds_preflight: true } }, {}));
  assert.ok(isPreflight({ value: '{"_zerocreds_preflight":true}' }, {}));
  assert.ok(!isPreflight({ key1: 'sk-real' }, {}));
  assert.ok(!isPreflight(null, {}));
});

test('buildDestination bakes ids into the URL — zerocreds only templates form fields', () => {
  const d = buildDestination({ origin: 'https://l.test', uid: UID, sid: 'cd'.repeat(16), provider: 'openai', webhookToken: 'wh' });
  assert.equal(d.type, 'http_post');
  assert.equal(d.url, `https://l.test/internal/creds?uid=${UID}&sid=${'cd'.repeat(16)}&provider=openai`);
  assert.equal(d.headers.Authorization, 'Bearer wh');
});

// ── landing routes ────────────────────────────────────────────────────────────

test('GET / mints an uid capability and redirects', async () => {
  const r = await get(env(), '/');
  assert.equal(r.status, 302);
  const loc = r.headers.get('location');
  assert.match(loc, /^https:\/\/l\.test\/u\/[0-9a-f]{32}$/);
  assert.match(r.headers.get('set-cookie'), /ladder_uid=[0-9a-f]{32}/);
});

test('GET / reuses the cookie uid instead of minting a new one', async () => {
  const r = await get(env(), '/', { headers: { cookie: `ladder_uid=${UID}` } });
  assert.equal(r.headers.get('location'), `https://l.test/u/${UID}`);
  assert.equal(r.headers.get('set-cookie'), null);
});

test('GET /u/{uid} renders provider buttons without leaking config internals', async () => {
  const r = await get(env(), `/u/${UID}`);
  assert.equal(r.status, 200);
  const body = await r.text();
  assert.match(body, /OpenRouter/);
  assert.match(body, new RegExp(`/u/${UID}/connect`));
  assert.ok(!body.includes('whsec'), 'webhook token leaked into HTML');
  assert.ok(!body.includes('admin'), 'admin token leaked into HTML');
  assert.ok(body.includes('noindex'));
});

// ── connect ───────────────────────────────────────────────────────────────────

test('POST /connect creates a zerocreds session and stores the sid mapping', async () => {
  const zc = fakeZeroCreds();
  const e = env();
  const r = await post(e, `/u/${UID}/connect`, { provider: 'openrouter' }, { accept: 'application/json' }, { fetchImpl: zc.fetchImpl });
  assert.equal(r.status, 200);
  const { sid, url } = await r.json();
  assert.ok(validSid(sid));
  assert.equal(url, 'https://zc.test/f/zc_tok');

  const created = JSON.parse(zc.calls[0].init.body);
  assert.equal(created.destination.type, 'http_post');
  assert.ok(created.destination.url.includes(`uid=${UID}`));
  assert.ok(created.destination.url.includes(`sid=${sid}`));
  assert.ok(created.destination.url.includes('provider=openrouter'));
  assert.equal(created.destination.headers.Authorization, 'Bearer whsec');
  assert.equal(created.fields.length, MAX_KEYS);
  assert.equal(created.fields[0].required, true);
  assert.ok(created.fields.slice(1).every(f => f.required === false));

  const meta = JSON.parse(await e.LADDER_CREDS.get(`sess:${sid}`));
  assert.equal(meta.uid, UID);
  assert.equal(meta.provider, 'openrouter');
  assert.equal(meta.zc, 'zc_tok');
});

test('POST /connect rejects unknown providers and missing config', async () => {
  assert.equal((await post(env(), `/u/${UID}/connect`, { provider: 'evil' }, {}, { fetchImpl: fakeZeroCreds().fetchImpl })).status, 400);
  assert.equal((await post(env({ ZEROCREDS_ADMIN_TOKEN: '' }), `/u/${UID}/connect`, { provider: 'openai' }, {}, { fetchImpl: fakeZeroCreds().fetchImpl })).status, 503);
  assert.equal((await post(env({ ZC_WEBHOOK_TOKEN: '' }), `/u/${UID}/connect`, { provider: 'openai' }, {}, { fetchImpl: fakeZeroCreds().fetchImpl })).status, 503);
  assert.equal((await post(env({ LADDER_CREDS: null }), `/u/${UID}/connect`, { provider: 'openai' }, {}, { fetchImpl: fakeZeroCreds().fetchImpl })).status, 503);
  const down = await post(env(), `/u/${UID}/connect`, { provider: 'openai' }, {}, { fetchImpl: fakeZeroCreds({ fail: true }).fetchImpl });
  assert.equal(down.status, 502);
  assert.ok(!(await down.text()).includes('admin'), 'admin token leaked in the error');
});

test('POST /connect answers a plain form with a redirect to zerocreds', async () => {
  const r = await post(env(), `/u/${UID}/connect`, { provider: 'zen' }, {}, { fetchImpl: fakeZeroCreds().fetchImpl });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), 'https://zc.test/f/zc_tok');
});

// ── webhook ───────────────────────────────────────────────────────────────────

async function connected(e) {
  const r = await post(e, `/u/${UID}/connect`, { provider: 'openrouter' }, { accept: 'application/json' }, { fetchImpl: fakeZeroCreds().fetchImpl });
  return (await r.json()).sid;
}

const webhook = (e, sid, body, headers = {}) =>
  post(e, `/internal/creds?uid=${UID}&sid=${sid}&provider=openrouter`, body, { authorization: 'Bearer whsec', ...headers });

test('webhook refuses a missing or wrong token', async () => {
  const e = env();
  const sid = await connected(e);
  assert.equal((await post(e, `/internal/creds?uid=${UID}&sid=${sid}&provider=openrouter`, { key1: 'x' })).status, 401);
  assert.equal((await webhook(e, sid, { key1: 'x' }, { authorization: 'Bearer nope' })).status, 401);
});

test('webhook answers the zerocreds pre-flight without writing anything', async () => {
  const e = env();
  const sid = await connected(e);
  const r = await webhook(e, sid, { _zerocreds_preflight: true });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).preflight, true);
  assert.equal(await e.LADDER_CREDS.get(credsKey(UID, sid)), null, 'probe must not be stored as a credential');
});

test('webhook encrypts the submitted keys into KV', async () => {
  const e = env();
  const sid = await connected(e);
  const r = await webhook(e, sid, { key1: 'sk-live-1', key2: '', key3: 'sk-live-3' });
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).count, 2);

  const blob = await e.LADDER_CREDS.get(credsKey(UID, sid));
  assert.match(blob, /^v1\./);
  assert.ok(!blob.includes('sk-live-1'), 'plaintext key stored in KV');
  const plain = await decryptValue(parseEncKey(ENC_KEY), blob);
  assert.deepEqual(plain.keys, ['sk-live-1', 'sk-live-3']);
  assert.equal(plain.provider, 'openrouter');
  assert.equal(plain.uid, UID);
});

test('webhook rejects unknown ids, unknown providers and empty submissions', async () => {
  const e = env();
  const sid = await connected(e);
  assert.equal((await post(e, `/internal/creds?uid=${'ff'.repeat(16)}&sid=${sid}&provider=openrouter`, { key1: 'x' }, { authorization: 'Bearer whsec' })).status, 404);
  assert.equal((await post(e, `/internal/creds?uid=${UID}&sid=${'ee'.repeat(16)}&provider=openrouter`, { key1: 'x' }, { authorization: 'Bearer whsec' })).status, 404);
  assert.equal((await post(e, `/internal/creds?uid=${UID}&sid=${sid}&provider=other`, { key1: 'x' }, { authorization: 'Bearer whsec' })).status, 400);
  assert.equal((await webhook(e, sid, {})).status, 400);
  assert.equal((await webhook(e, sid, { key1: '   ' })).status, 400);
});

test('webhook fails closed when the encryption key is unusable', async () => {
  const e = env({ CREDS_ENC_KEY: 'nope' });
  const sid = await connected(e);
  const r = await webhook(e, sid, { key1: 'sk-live-1' });
  assert.equal(r.status, 503);
  assert.ok(!(await r.text()).includes('sk-live-1'));
});

// ── status + listing ──────────────────────────────────────────────────────────

test('GET /status reports zerocreds state and metadata only', async () => {
  const e = env();
  const sid = await connected(e);
  await webhook(e, sid, { key1: 'sk-live-1' });

  const r = await get(e, `/u/${UID}/status/${sid}`, {}, { fetchImpl: fakeZeroCreds({ status: 'done' }).fetchImpl });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.status, 'done');
  assert.equal(body.provider, 'openrouter');
  assert.equal(body.saved.length, 1);
  assert.equal(body.saved[0].count, 1);
  assert.ok(!JSON.stringify(body).includes('sk-live-1'), 'key leaked through the status endpoint');

  const pending = await get(e, `/u/${UID}/status/${sid}`, {}, { fetchImpl: fakeZeroCreds({ status: 'pending' }).fetchImpl });
  assert.deepEqual((await pending.json()).saved, []);
});

test('GET /status is 404 for a sid we never minted or a foreign uid', async () => {
  const e = env();
  const sid = await connected(e);
  assert.equal((await get(e, `/u/${UID}/status/${'ee'.repeat(16)}`)).status, 404);
  assert.equal((await get(e, `/u/${'ff'.repeat(16)}/status/${sid}`)).status, 404);
});

test('listCredsMeta returns metadata without the keys', async () => {
  const e = env();
  const sid = await connected(e);
  await webhook(e, sid, { key1: 'sk-live-1' });
  const meta = await listCredsMeta(e.LADDER_CREDS, parseEncKey(ENC_KEY), UID);
  assert.equal(meta.length, 1);
  assert.equal(meta[0].sid, sid);
  assert.equal(meta[0].provider, 'openrouter');
  assert.ok(!JSON.stringify(meta).includes('sk-live-1'));
});

// ── the ladder gate is untouched ──────────────────────────────────────────────

test('/v1/* still requires the ladder token — public routes do not open the API', async () => {
  const e = env();
  assert.equal((await get(e, '/v1/models')).status, 401);
  assert.equal((await get(e, '/v1/state')).status, 401);
  assert.equal((await post(e, '/v1/chat/completions', { messages: [{ role: 'user', content: 'x' }] })).status, 401);
  assert.equal((await get(e, '/health')).status, 200);
});

test('unknown paths behave as before: gated first, 404 once authorised', async () => {
  const e = env();
  assert.equal((await get(e, '/nope')).status, 401, 'unauthenticated guesses must not learn the route map');
  const authed = await get(e, '/nope', { headers: { authorization: 'Bearer t' } });
  assert.equal(authed.status, 404);
});
