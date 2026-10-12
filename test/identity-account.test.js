import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bootstrapAdmin,
  createAccount,
  listAccounts,
  listKeys,
  issueKey,
  revokeKey,
  disableUser,
  enableUser,
} from '../src/identity-account.js';
import { initIdentityTables } from '../src/identity-repository.js';
import { bootstrapCommand } from '../scripts/identity-bootstrap.mjs';
import { cliCommand } from '../scripts/identity-cli.mjs';

function localD1() {
  const db = new DatabaseSync(':memory:');
  return {
    _db: db,
    prepare(sql) {
      return {
        bind: (...params) => ({
          first: async () => db.prepare(sql).get(...params) ?? null,
          all: async () => ({ results: db.prepare(sql).all(...params) }),
          run: async () => {
            const info = db.prepare(sql).run(...params);
            return { meta: { changes: Number(info.changes) } };
          },
        }),
      };
    },
    async exec(sql) {
      db.exec(sql);
    },
    close() {
      db.close();
    },
  };
}

async function seededDb() {
  const db = localD1();
  await initIdentityTables(db);
  return db;
}

test('bootstrapAdmin: creates admin user idempotently', async () => {
  const db = await seededDb();
  const first = await bootstrapAdmin(db, { email: 'admin@test.com' });
  assert.equal(first.created, true);
  assert.equal(first.email, 'admin@test.com');
  assert.equal(first.role, 'admin');
  assert.equal(first.status, 'active');

  const second = await bootstrapAdmin(db, { email: 'admin@test.com' });
  assert.equal(second.created, false);
  assert.equal(second.userId, first.userId);
  db.close();
});

test('bootstrapAdmin: rejects invalid email', async () => {
  const db = await seededDb();
  await assert.rejects(() => bootstrapAdmin(db, { email: 'not-an-email' }));
  db.close();
});

test('bootstrapAdmin: rejects invalid role', async () => {
  const db = await seededDb();
  await assert.rejects(() => bootstrapAdmin(db, { email: 'a@b.com', role: 'superadmin' }));
  db.close();
});

test('createAccount: supports recruiter and sales roles', async () => {
  const db = await seededDb();
  const recruiter = await createAccount(db, { email: 'recruiter@test.com', role: 'recruiter' });
  assert.equal(recruiter.role, 'recruiter');
  assert.equal(recruiter.status, 'active');

  const sales = await createAccount(db, { email: 'sales@test.com', role: 'sales' });
  assert.equal(sales.role, 'sales');

  const users = await listAccounts(db);
  assert.equal(users.length, 2);
  db.close();
});

test('createAccount: rejects invalid role', async () => {
  const db = await seededDb();
  await assert.rejects(() => createAccount(db, { email: 'a@b.com', role: 'hacker' }));
  db.close();
});

test('listAccounts: does not expose sensitive data', async () => {
  const db = await seededDb();
  await createAccount(db, { email: 'user@test.com', role: 'user' });
  const users = await listAccounts(db);
  assert.equal(users.length, 1);
  const u = users[0];
  assert.ok(!('keyHash' in u), 'keyHash must not be exposed');
  assert.ok(!('token' in u), 'token must not be exposed');
  assert.ok(u.userId);
  assert.ok(u.email);
  db.close();
});

test('issueKey: returns key once, listKeys does not expose keyHash', async () => {
  const db = await seededDb();
  const user = await createAccount(db, { email: 'user@test.com' });
  const { key, keyHash } = await issueKey(db, { userId: user.userId, label: 'test-key' });
  assert.ok(key);
  assert.ok(keyHash);
  assert.notEqual(key, keyHash);

  const keys = await listKeys(db, user.userId);
  assert.equal(keys.length, 1);
  const k = keys[0];
  assert.equal(k.label, 'test-key');
  assert.equal(k.status, 'active');
  assert.ok(!('keyHash' in k), 'keyHash must not be exposed in listKeys');
  assert.ok(!('key' in k), 'raw key must not be exposed in listKeys');
  db.close();
});

test('revokeKey: revoked key stops working', async () => {
  const db = await seededDb();
  const user = await createAccount(db, { email: 'user@test.com' });
  const { keyHash } = await issueKey(db, { userId: user.userId, label: 'k1' });

  const revoked = await revokeKey(db, keyHash);
  assert.equal(revoked, true);

  const keys = await listKeys(db, user.userId);
  assert.equal(keys[0].status, 'active');
  assert.ok(keys[0].revokedAt);

  const second = await revokeKey(db, keyHash);
  assert.equal(second, false);
  db.close();
});

test('disableUser: disabled user cannot authenticate', async () => {
  const db = await seededDb();
  const user = await createAccount(db, { email: 'user@test.com' });
  const { key } = await issueKey(db, { userId: user.userId, label: 'k1' });

  const changed = await disableUser(db, user.userId);
  assert.equal(changed, true);

  const users = await listAccounts(db);
  assert.equal(users[0].status, 'disabled');

  const second = await disableUser(db, user.userId);
  assert.equal(second, false);
  db.close();
});

test('enableUser: re-enables a disabled user', async () => {
  const db = await seededDb();
  const user = await createAccount(db, { email: 'user@test.com' });
  await disableUser(db, user.userId);
  const changed = await enableUser(db, user.userId);
  assert.equal(changed, true);

  const users = await listAccounts(db);
  assert.equal(users[0].status, 'active');

  const second = await enableUser(db, user.userId);
  assert.equal(second, false);
  db.close();
});

test('bootstrapCommand: creates admin and writes key to protected file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'identity-bootstrap-'));
  const keyFile = join(dir, 'admin-key');
  let savedKey = null;
  const saveKey = (key, file) => {
    savedKey = key;
    writeFileSync(file, key + '\n', { mode: 0o600 });
  };
  const out = [];
  const err = [];
  const code = await bootstrapCommand(
    ['--email', 'admin@test.com', '--key-file', keyFile],
    { out: t => out.push(t), err: t => err.push(t), saveKey }
  );
  assert.equal(code, 0);
  assert.ok(savedKey, 'key should be saved');
  assert.ok(savedKey.length > 20, 'key should be a long random string');

  const content = readFileSync(keyFile, 'utf8').trim();
  assert.equal(content, savedKey);
  const stat = statSync(keyFile);
  assert.equal(stat.mode & 0o777, 0o600);
  assert.ok(out.join('').includes('Admin user created'));
  assert.ok(!out.join('').includes(savedKey), 'key must not appear in stdout');
});

test('bootstrapCommand: is repeat-safe', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'identity-bootstrap-'));
  const keyFile = join(dir, 'admin-key');
  const dbFile = join(dir, 'test.db');
  const saveKey = (key, file) => { writeFileSync(file, key + '\n', { mode: 0o600 }); };
  const out1 = [];
  const code1 = await bootstrapCommand(
    ['--email', 'admin@test.com', '--db', dbFile, '--key-file', keyFile],
    { out: t => out1.push(t), err: () => {}, saveKey }
  );
  assert.equal(code1, 0);

  const out2 = [];
  const code2 = await bootstrapCommand(
    ['--email', 'admin@test.com', '--db', dbFile, '--key-file', keyFile],
    { out: t => out2.push(t), err: () => {}, saveKey }
  );
  assert.equal(code2, 0);
  assert.ok(out2.join('').includes('already exists'));
});

test('cliCommand: create and list users', async () => {
  const out = [];
  const err = [];
  const code = await cliCommand(
    ['create', '--email', 'cli@test.com', '--role', 'recruiter'],
    { out: t => out.push(t), err: t => err.push(t) }
  );
  assert.equal(code, 0);
  assert.ok(out.join('').includes('cli@test.com'));
  assert.ok(out.join('').includes('recruiter'));
});

test('cliCommand: key issue and list', async () => {
  const out = [];
  const err = [];

  const code1 = await cliCommand(
    ['create', '--email', 'key@test.com'],
    { out: t => out.push(t), err: t => err.push(t) }
  );
  assert.equal(code1, 0);

  const code2 = await cliCommand(
    ['list'],
    { out: t => out.push(t), err: t => err.push(t) }
  );
  assert.equal(code2, 0);

  const out2 = [];
  const code3 = await cliCommand(
    ['key', 'list', '--user', 'user_00000000000000000000000000000001'],
    { out: t => out2.push(t), err: () => {} }
  );
  assert.equal(code3, 0);
});
