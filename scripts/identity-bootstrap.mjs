#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { bootstrapAdmin, issueKey } from '../src/identity-account.js';
import { initIdentityTables } from '../src/identity-repository.js';

function parseArgs(args) {
  const opts = { email: null, userId: null, db: null, keyFile: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--email' && args[i + 1]) { opts.email = args[++i]; }
    else if (args[i] === '--user-id' && args[i + 1]) { opts.userId = args[++i]; }
    else if (args[i] === '--db' && args[i + 1]) { opts.db = args[++i]; }
    else if (args[i] === '--key-file' && args[i + 1]) { opts.keyFile = args[++i]; }
    else if (args[i] === '--help') { opts.help = true; }
  }
  return opts;
}

function wrapD1(db) {
  return {
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
  };
}

function openDb(dbPath) {
  const raw = dbPath ? new DatabaseSync(dbPath) : new DatabaseSync(':memory:');
  const db = wrapD1(raw);
  return { db, close: () => raw.close() };
}

function saveKeyToFile(key, file) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, key + '\n', { mode: 0o600 });
  chmodSync(file, 0o600);
}

export async function bootstrapCommand(args, {
  out = text => process.stdout.write(text),
  err = text => process.stderr.write(text),
  saveKey = saveKeyToFile,
} = {}) {
  const opts = parseArgs(args);
  if (opts.help) {
    out('Usage: node scripts/identity-bootstrap.mjs --email <email> [--user-id <id>] [--db <path>] [--key-file <path>]\n');
    out('Creates the first admin user (idempotent), issues a key, and writes it to a protected file (0600).\n');
    out('The key is NEVER printed to stdout. Use --key-file to specify the output path.\n');
    out('If --db is omitted, an in-memory database is used (for testing only).\n');
    return 0;
  }
  if (!opts.email) {
    err('Error: --email is required\n');
    return 2;
  }
  const { db, close } = openDb(opts.db);
  try {
    await initIdentityTables(db);
    const admin = await bootstrapAdmin(db, { email: opts.email, userId: opts.userId });
    if (!admin.created) {
      out(`Admin user already exists: ${admin.userId} (${admin.email})\n`);
      out('Use the CLI to issue a new key if needed.\n');
      return 0;
    }
    const { key } = await issueKey(db, { userId: admin.userId, label: 'bootstrap-admin' });
    const keyFile = opts.keyFile || join(process.env.HOME || '/tmp', '.local', 'ladder', 'admin-key');
    saveKey(key, keyFile);
    out(`Admin user created: ${admin.userId} (${admin.email})\n`);
    out(`Key written to: ${keyFile} (0600)\n`);
    return 0;
  } catch (e) {
    err(`Error: ${e.message}\n`);
    return 1;
  } finally {
    close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await bootstrapCommand(process.argv.slice(2));
}
