#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  createAccount,
  listAccounts,
  listKeys,
  issueKey,
  revokeKey,
  disableUser,
  enableUser,
} from '../src/identity-account.js';
import { initIdentityTables } from '../src/identity-repository.js';

function parseArgs(args) {
  const opts = { command: args[0], positional: [], flags: {} };
  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      opts.flags[key] = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true;
    } else {
      opts.positional.push(args[i]);
    }
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

const HELP = `Usage: node scripts/identity-cli.mjs <command> [options]

Commands:
  create --email <email> [--role <role>] [--service <service>] [--user-id <id>]
  list
  key issue --user <userId> [--label <label>] [--expires-at <ms>]
  key revoke --hash <keyHash>
  key list --user <userId>
  disable --user <userId>
  enable --user <userId>

Options:
  --db <path>    SQLite file path (default: in-memory, for testing)
  --help         Show this help

Roles: admin, user, recruiter, sales
`;

function formatUser(u) {
  return `${u.userId}  ${u.email}  role=${u.role}  status=${u.status}  service=${u.service}`;
}

function formatKey(k) {
  const parts = [`label=${k.label}`, `status=${k.status}`];
  if (k.expiresAt) parts.push(`expires=${new Date(k.expiresAt).toISOString()}`);
  if (k.revokedAt) parts.push(`revoked=${new Date(k.revokedAt).toISOString()}`);
  return parts.join('  ');
}

export async function cliCommand(args, { out = text => process.stdout.write(text), err = text => process.stderr.write(text) } = {}) {
  const opts = parseArgs(args);
  if (opts.flags.help || !opts.command) {
    out(HELP);
    return opts.command ? 2 : 0;
  }
  const dbPath = opts.flags.db || null;
  const { db, close } = openDb(dbPath);
  try {
    await initIdentityTables(db);
    switch (opts.command) {
      case 'create': {
        const email = opts.flags.email;
        if (!email) { err('Error: --email is required\n'); return 2; }
        const user = await createAccount(db, {
          userId: opts.flags['user-id'],
          email,
          role: opts.flags.role,
          service: opts.flags.service,
        });
        out(`Created: ${formatUser(user)}\n`);
        return 0;
      }
      case 'list': {
        const users = await listAccounts(db);
        if (!users.length) { out('No users found.\n'); return 0; }
        users.forEach((u) => out(formatUser(u) + '\n'));
        return 0;
      }
      case 'key': {
        const sub = opts.positional[0];
        if (sub === 'issue') {
          const userId = opts.flags.user;
          if (!userId) { err('Error: --user is required\n'); return 2; }
          const { key, keyHash } = await issueKey(db, {
            userId,
            label: opts.flags.label || 'cli-key',
            expiresAt: opts.flags['expires-at'] ? Number(opts.flags['expires-at']) : null,
          });
          out(`Key issued for ${userId}\n`);
          out(`Key: ${key}\n`);
          out(`Hash: ${keyHash}\n`);
          return 0;
        }
        if (sub === 'revoke') {
          const keyHash = opts.flags.hash;
          if (!keyHash) { err('Error: --hash is required\n'); return 2; }
          const revoked = await revokeKey(db, keyHash);
          out(revoked ? 'Key revoked.\n' : 'Key not found or already revoked.\n');
          return 0;
        }
        if (sub === 'list') {
          const userId = opts.flags.user;
          if (!userId) { err('Error: --user is required\n'); return 2; }
          const keys = await listKeys(db, userId);
          if (!keys.length) { out('No keys found.\n'); return 0; }
          keys.forEach((k) => out(formatKey(k) + '\n'));
          return 0;
        }
        err('Error: key subcommand must be issue, revoke, or list\n');
        return 2;
      }
      case 'disable': {
        const userId = opts.flags.user;
        if (!userId) { err('Error: --user is required\n'); return 2; }
        const changed = await disableUser(db, userId);
        out(changed ? `User ${userId} disabled.\n` : `User ${userId} not found or already disabled.\n`);
        return 0;
      }
      case 'enable': {
        const userId = opts.flags.user;
        if (!userId) { err('Error: --user is required\n'); return 2; }
        const changed = await enableUser(db, userId);
        out(changed ? `User ${userId} enabled.\n` : `User ${userId} not found or already enabled.\n`);
        return 0;
      }
      default:
        err(`Error: unknown command "${opts.command}"\n`);
        out(HELP);
        return 2;
    }
  } catch (e) {
    err(`Error: ${e.message}\n`);
    return 1;
  } finally {
    close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await cliCommand(process.argv.slice(2));
}
