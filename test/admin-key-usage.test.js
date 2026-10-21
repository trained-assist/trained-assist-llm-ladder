import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { handle } from '../src/handler.js';
import { logCall } from '../src/trace.js';

function d1() {
  const raw = new DatabaseSync(':memory:');
  return {
    raw,
    async batch(statements) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
    prepare(sql) {
      return { all: async () => ({ results: raw.prepare(sql).all() }), bind(...values) {
        return { first: async () => raw.prepare(sql).get(...values) || null,
          all: async () => ({ results: raw.prepare(sql).all(...values) }),
          run: async () => { const r = raw.prepare(sql).run(...values); return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; } };
      } };
    },
  };
}

test('admin usage attributes calls to keys and suspend/resume blocks only that key', async () => {
  const db = d1();
  try {
    db.raw.exec(await readFile(new URL('../schema/ladder_calls.sql', import.meta.url), 'utf8'));
    db.raw.exec(await readFile(new URL('../schema/migrations/0005_app.sql', import.meta.url), 'utf8'));
    db.raw.exec(await readFile(new URL('../schema/migrations/0009_identity.sql', import.meta.url), 'utf8'));
    db.raw.exec(await readFile(new URL('../schema/migrations/0015_key_events.sql', import.meta.url), 'utf8'));
    const key = 'personal-key-one';
    const keyHash = createHash('sha256').update(key).digest('hex');
    db.raw.prepare("INSERT INTO identity_users (user_id,email,role,status,created_at,updated_at) VALUES ('u1','u1@example.test','user','active',1,1)").run();
    db.raw.prepare("INSERT INTO identity_api_keys (key_hash,user_id,label,status,created_at) VALUES (?,?,?,'active',1)").run(keyHash, 'u1', 'Mac');
    const env = { LADDER_TOKEN: 'admin', LADDER_TRACE_DB: db };
    await logCall(env, { userId: 'u1', keyHash, app: 'opencode-mac' }, 'service',
      { ok: true, model: 'opencode-go/space-bunny-free', attempts: [], data: { usage: { prompt_tokens: 30, completion_tokens: 5 } } }, Date.now());
    const req = (path, token = 'admin', method = 'GET') => handle(new Request(`https://ladder.test${path}`,
      { method, headers: { authorization: `Bearer ${token}` } }), env);
    const adminPage = await handle(new Request('https://ladder.test/admin'), env);
    assert.equal(adminPage.status, 200);
    assert.match(await adminPage.text(), /Расход по ключам/);
    assert.equal((await handle(new Request('https://ladder.test/admin/api/keys'), env)).status, 401);
    const connected = await handle(new Request('https://ladder.test/admin/connect', {
      method: 'POST', headers: { origin: 'https://ladder.test', 'content-type': 'application/x-www-form-urlencoded' },
      body: 'key=admin',
    }), env);
    assert.equal(connected.status, 303);
    assert.match(connected.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Strict/);
    const cookie = connected.headers.get('set-cookie').split(';')[0];
    assert.equal((await handle(new Request('https://ladder.test/admin/api/keys', { headers: { cookie } }), env)).status, 200);
    const usage = await req('/v1/admin/key-usage?period=15m');
    assert.equal(usage.status, 200);
    const row = (await usage.json()).rows[0];
    assert.equal(row.key_id, keyHash.slice(0, 16));
    assert.equal(row.key_label, 'Mac');
    assert.equal(row.tier, 'free');
    assert.deepEqual([row.calls, row.successful, row.failed, row.tokens_in, row.tokens_out], [1, 1, 0, 30, 5]);
    assert.equal((await req('/v1/admin/key-usage', key)).status, 403);
    const keys = await req('/v1/admin/keys');
    assert.equal(keys.status, 200);
    assert.deepEqual((await keys.json()).keys.map((item) => [item.key_id, item.label, item.status]),
      [[keyHash.slice(0, 16), 'Mac', 'active']]);
    assert.equal((await req('/v1/admin/keys', key)).status, 403);
    assert.equal((await req(`/v1/admin/keys/${row.key_id}/suspend`, 'admin', 'POST')).status, 200);
    assert.equal((await req('/v1/models', key)).status, 401);
    assert.equal((await req(`/v1/admin/keys/${row.key_id}/resume`, 'admin', 'POST')).status, 200);
    assert.equal((await req('/v1/models', key)).status, 200);
    assert.equal((await req(`/v1/admin/keys/${row.key_id}/revoke`, 'admin', 'POST')).status, 200);
    assert.equal((await req(`/v1/admin/keys/${row.key_id}/resume`, 'admin', 'POST')).status, 409);
    assert.deepEqual(db.raw.prepare('SELECT action FROM identity_key_events ORDER BY id').all().map((event) => event.action),
      ['suspend', 'resume', 'revoke']);
  } finally { db.raw.close(); }
});
