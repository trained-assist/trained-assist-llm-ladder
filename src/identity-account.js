import { randomBytes } from 'node:crypto';
import { createUser, issueApiKey, revokeApiKey } from './identity-repository.js';

const VALID_ROLES = ['admin', 'user', 'recruiter', 'sales'];

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function generateUserId() {
  return 'user_' + randomBytes(16).toString('hex');
}

export async function bootstrapAdmin(db, { email, userId, role = 'admin' }) {
  if (!db) throw new Error('D1 binding required');
  if (!isValidEmail(email)) throw new Error('Valid email required');
  if (!VALID_ROLES.includes(role)) throw new Error(`Role must be one of: ${VALID_ROLES.join(', ')}`);
  const existing = await db.prepare(
    'SELECT user_id, email, role, service, status FROM identity_users WHERE email = ?'
  ).bind(email).first();
  if (existing) {
    return { userId: existing.user_id, email: existing.email, role: existing.role, service: existing.service, status: existing.status, created: false };
  }
  const uid = userId || generateUserId();
  await createUser(db, { userId: uid, email, role, service: 'ladder' });
  return { userId: uid, email, role, service: 'ladder', status: 'active', created: true };
}

export async function createAccount(db, { userId, email, role = 'user', service = 'ladder' }) {
  if (!db) throw new Error('D1 binding required');
  if (!isValidEmail(email)) throw new Error('Valid email required');
  if (!VALID_ROLES.includes(role)) throw new Error(`Role must be one of: ${VALID_ROLES.join(', ')}`);
  const uid = userId || generateUserId();
  await createUser(db, { userId: uid, email, role, service });
  return { userId: uid, email, role, service, status: 'active' };
}

export async function listAccounts(db) {
  if (!db) throw new Error('D1 binding required');
  const { results } = await db.prepare(
    'SELECT user_id, email, role, service, status, created_at, updated_at FROM identity_users ORDER BY created_at DESC'
  ).bind().all();
  return results.map((r) => ({
    userId: r.user_id,
    email: r.email,
    role: r.role,
    service: r.service,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export async function listKeys(db, userId) {
  if (!db) throw new Error('D1 binding required');
  const { results } = await db.prepare(
    'SELECT label, status, expires_at, revoked_at, created_at, last_used_at FROM identity_api_keys WHERE user_id = ? ORDER BY created_at DESC'
  ).bind(userId).all();
  return results.map((r) => ({
    label: r.label,
    status: r.status,
    expiresAt: r.expires_at,
    revokedAt: r.revoked_at,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
  }));
}

export async function issueKey(db, { userId, label, expiresAt = null }) {
  if (!db) throw new Error('D1 binding required');
  if (!userId) throw new Error('userId required');
  if (!label) throw new Error('label required');
  const user = await db.prepare('SELECT user_id FROM identity_users WHERE user_id = ?').bind(userId).first();
  if (!user) throw new Error('User not found');
  return issueApiKey(db, { userId, label, expiresAt });
}

export async function revokeKey(db, keyHash) {
  if (!db) throw new Error('D1 binding required');
  if (!keyHash) throw new Error('keyHash required');
  return revokeApiKey(db, keyHash);
}

export async function disableUser(db, userId) {
  if (!db) throw new Error('D1 binding required');
  if (!userId) throw new Error('userId required');
  const result = await db.prepare(
    "UPDATE identity_users SET status = 'disabled', updated_at = ? WHERE user_id = ? AND status != 'disabled'"
  ).bind(Date.now(), userId).run();
  return result.meta.changes > 0;
}

export async function enableUser(db, userId) {
  if (!db) throw new Error('D1 binding required');
  if (!userId) throw new Error('userId required');
  const result = await db.prepare(
    "UPDATE identity_users SET status = 'active', updated_at = ? WHERE user_id = ? AND status != 'active'"
  ).bind(Date.now(), userId).run();
  return result.meta.changes > 0;
}
