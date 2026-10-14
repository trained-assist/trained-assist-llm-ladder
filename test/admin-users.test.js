import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { handle } from '../src/handler.js';
import { verifyKey } from '../src/identity-repository.js';

function localD1() {
  const db = new DatabaseSync(':memory:');
  const prepare = (sql) => ({
    bind: (...args) => ({
      first: async () => db.prepare(sql).get(...args) ?? null,
      run: async () => {
        const result = db.prepare(sql).run(...args);
        return { meta: { changes: Number(result.changes) } };
      },
    }),
  });
  return {
    prepare,
    async batch(statements) {
      const result = [];
      for (const statement of statements) result.push(await statement.run());
      return result;
    },
    exec: async (sql) => db.exec(sql),
    close: () => db.close(),
  };
}

async function setup() {
  const db = localD1();
  await db.exec(await readFile(new URL('../schema/migrations/0009_identity.sql', import.meta.url), 'utf8'));
  const env = { LADDER_TOKEN: 'test-admin-token', LADDER_TRACE_DB: db };
  return { db, env };
}

test('admin provisioning preserves an explicitly supplied identity ID and issues a working personal key', async () => {
  const { db, env } = await setup();
  try {
    const response = await handle(new Request('https://ladder.test/v1/admin/users', {
      method: 'POST',
      headers: { authorization: 'Bearer test-admin-token', 'content-type': 'application/json' },
      body: JSON.stringify({ user_id: 'telegram-user-001', email: 'owner@example.com', role: 'admin', label: 'Mem-GPT OpenCode' }),
    }), env);
    assert.equal(response.status, 201);
    const result = await response.json();
    assert.equal(result.user.user_id, 'telegram-user-001');
    assert.equal(result.user.email, 'owner@example.com');
    assert.equal((await verifyKey(db, result.token)).userId, 'telegram-user-001');
  } finally {
    db.close();
  }
});

test('admin provisioning rejects malformed explicit identity IDs', async () => {
  const { db, env } = await setup();
  try {
    const response = await handle(new Request('https://ladder.test/v1/admin/users', {
      method: 'POST',
      headers: { authorization: 'Bearer test-admin-token', 'content-type': 'application/json' },
      body: JSON.stringify({ user_id: 'not an id', email: 'owner@example.com' }),
    }), env);
    assert.equal(response.status, 400);
  } finally {
    db.close();
  }
});

test('admin token endpoint issues a one-time personal token and stores only its hash', async () => {
  const { db, env } = await setup();
  try {
    await db.prepare(`INSERT INTO identity_users (user_id, email, role, service, status, created_at, updated_at)
                      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind('owner-001', 'owner@example.com', 'admin', 'ladder', 'active', Date.now(), Date.now()).run();

    const response = await handle(new Request('https://ladder.test/v1/users/owner-001/tokens', {
      method: 'POST',
      headers: { authorization: 'Bearer test-admin-token', 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'Mem-GPT OpenCode' }),
    }), env);
    assert.equal(response.status, 201);
    const result = await response.json();
    assert.equal(result.user_id, 'owner-001');
    assert.equal(result.label, 'Mem-GPT OpenCode');
    assert.equal((await verifyKey(db, result.token)).userId, 'owner-001');

    const stored = db.prepare('SELECT key_hash FROM identity_api_keys WHERE user_id = ?').bind('owner-001');
    const row = await stored.first();
    assert.notEqual(row.key_hash, result.token);
    assert.match(row.key_hash, /^[a-f0-9]{64}$/);
  } finally {
    db.close();
  }
});

test('personal users cannot issue keys or create accounts', async () => {
  const { db, env } = await setup();
  try {
    const provision = await handle(new Request('https://ladder.test/v1/admin/users', {
      method: 'POST',
      headers: { authorization: 'Bearer test-admin-token', 'content-type': 'application/json' },
      body: JSON.stringify({ user_id: 'owner-001', email: 'owner@example.com', role: 'user' }),
    }), env);
    const { token } = await provision.json();

    const response = await handle(new Request('https://ladder.test/v1/users/owner-001/tokens', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'attempted-escalation' }),
    }), env);
    assert.equal(response.status, 403);
  } finally {
    db.close();
  }
});
