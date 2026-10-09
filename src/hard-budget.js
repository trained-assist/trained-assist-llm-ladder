// Fail-closed primitives for the sandbox hard-budget contract.
import { estimateBudgetInput } from './size-policy.js';
const encoder = new TextEncoder();
const encoderFatal = new TextDecoder('utf-8', { fatal: true });

function bytes(value) { return encoder.encode(value); }

function base64url(input) {
  let binary = '';
  for (const byte of input) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function decodeBase64url(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('invalid encoding');
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function isPositiveInteger(n) { return Number.isSafeInteger(n) && n > 0; }

function validateClaims(claims, nowSeconds) {
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) throw new Error('invalid capability');
  const fields = ['v', 'issuer', 'audience', 'taskId', 'runId', 'policyId', 'maxTokens', 'expiresAt'];
  if (fields.some((field) => !Object.hasOwn(claims, field))) throw new Error('missing capability field');
  if (claims.v !== 1 || claims.issuer !== 'trained-assist-cp' || claims.audience !== 'trained-assist-llm-ladder') throw new Error('wrong capability audience');
  for (const key of ['taskId', 'runId', 'policyId']) {
    if (typeof claims[key] !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(claims[key])) throw new Error(`invalid ${key}`);
  }
  if (!isPositiveInteger(claims.maxTokens) || claims.maxTokens > 10_000_000) throw new Error('invalid token ceiling');
  if (!isPositiveInteger(claims.expiresAt) || claims.expiresAt <= nowSeconds || claims.expiresAt > nowSeconds + 3600) throw new Error('expired or overlong capability');
  return claims;
}

async function hmacKey(secret, usage) {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('budget capability secret is not configured');
  return crypto.subtle.importKey('raw', bytes(secret), { name: 'HMAC', hash: 'SHA-256' }, false, usage);
}

export async function signBudgetCapability(claims, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  validateClaims(claims, nowSeconds);
  const payload = base64url(bytes(JSON.stringify(claims)));
  const key = await hmacKey(secret, ['sign']);
  const signature = base64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, bytes(payload))));
  return `${payload}.${signature}`;
}

export async function verifyBudgetCapability(token, secret, expected, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (typeof token !== 'string' || token.length > 4096) throw new Error('invalid capability');
  const parts = token.split('.');
  if (parts.length !== 2) throw new Error('invalid capability');
  const [payload, signature] = parts;
  const key = await hmacKey(secret, ['verify']);
  if (!await crypto.subtle.verify('HMAC', key, decodeBase64url(signature), bytes(payload))) throw new Error('invalid capability signature');
  let claims;
  try { claims = JSON.parse(encoderFatal.decode(decodeBase64url(payload))); } catch { throw new Error('invalid capability payload'); }
  validateClaims(claims, nowSeconds);
  for (const field of ['taskId', 'runId', 'policyId']) {
    if (expected?.[field] !== undefined && expected[field] !== claims[field]) throw new Error(`capability ${field} mismatch`);
  }
  return claims;
}

// Atomic UPDATE with a conditional ceiling check. A follow-up SELECT distinguishes exhaustion;
// callers never issue a provider request unless reserveTokenBudget returns reserved=true.
export async function reserveTokenBudget(db, claims, reservationId, amount) {
  if (!db || typeof db.prepare !== 'function') throw new Error('budget ledger unavailable');
  if (typeof db.batch !== 'function') throw new Error('atomic budget ledger unavailable');
  if (typeof reservationId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(reservationId)) throw new Error('invalid reservation id');
  if (!isPositiveInteger(amount) || amount > claims.maxTokens) throw new Error('invalid reservation amount');
  const now = Date.now();
  const results = await db.batch([
    db.prepare(`
      UPDATE ladder_budget_tasks SET reserved_tokens = reserved_tokens + ?4, updated_at = ?5
      WHERE task_id = ?1 AND run_id = ?2 AND policy_id = ?6 AND status = 'active'
        AND ?4 <= max_tokens - reserved_tokens
        AND NOT EXISTS (SELECT 1 FROM ladder_budget_reservations WHERE task_id = ?1 AND run_id = ?2 AND reservation_id = ?3)
    `).bind(claims.taskId, claims.runId, reservationId, amount, now, claims.policyId),
    db.prepare(`
      INSERT INTO ladder_budget_reservations (task_id, run_id, reservation_id, reserved_tokens, status, created_at, updated_at)
      SELECT ?1, ?2, ?3, ?4, 'reserved', ?5, ?5 WHERE changes() = 1
    `).bind(claims.taskId, claims.runId, reservationId, amount, now),
  ]);
  if (results[0]?.meta?.changes === 1 && results[1]?.meta?.changes === 1) return { reserved: true, reservationId, amount };
  const existing = await db.prepare(`
    SELECT reserved_tokens, status FROM ladder_budget_reservations
    WHERE task_id = ?1 AND run_id = ?2 AND reservation_id = ?3
  `).bind(claims.taskId, claims.runId, reservationId).first();
  if (existing) {
    if (existing.reserved_tokens !== amount) throw new Error('reservation id reused with different amount');
    return { reserved: false, reason: 'reservation_already_exists', reservationId, amount: existing.reserved_tokens, replay: true, status: existing.status };
  }
  const task = await db.prepare(`
    SELECT max_tokens, reserved_tokens, policy_id, status FROM ladder_budget_tasks
    WHERE task_id = ?1 AND run_id = ?2
  `).bind(claims.taskId, claims.runId).first();
  if (!task || task.policy_id !== claims.policyId || task.status !== 'active') throw new Error('budget task is missing or inactive');
  return { reserved: false, reason: 'budget_exhausted', maxTokens: task.max_tokens, reservedTokens: task.reserved_tokens };
}

export async function reconcileTokenBudget(db, claims, reservationId, usageTokens, outcome) {
  if (!db || typeof db.prepare !== 'function') throw new Error('budget ledger unavailable');
  if (!['settled', 'unknown'].includes(outcome)) throw new Error('invalid reservation outcome');
  if (outcome === 'unknown') usageTokens = null;
  else if (!Number.isSafeInteger(usageTokens) || usageTokens < 0) throw new Error('invalid usage');
  const status = outcome;
  // Preserve the full reservation for unknown outcomes. For known usage, release only the
  // measured difference in one transaction; cumulative usage remains charged to the task.
  if (typeof db.batch !== 'function') throw new Error('atomic budget ledger unavailable');
  const row = await db.prepare(`
    SELECT reserved_tokens, status FROM ladder_budget_reservations
    WHERE task_id = ?1 AND run_id = ?2 AND reservation_id = ?3
  `).bind(claims.taskId, claims.runId, reservationId).first();
  if (!row) throw new Error('reservation not found');
  if (row.status !== 'reserved') {
    if (row.status === status) return { status: row.status, replay: true };
    throw new Error('reservation already reconciled');
  }
  if (outcome === 'settled' && usageTokens > row.reserved_tokens) {
    // Provider usage exceeded the worst-case reservation: retain the reservation and raise a
    // hard violation. The host must close/fail the task; silently capping would lie about cost.
    throw new Error('provider usage exceeded reservation');
  }
  const charged = outcome === 'unknown' ? row.reserved_tokens : usageTokens;
  const now = Date.now();
  const results = await db.batch([
    db.prepare(`
      UPDATE ladder_budget_reservations SET status = ?4, usage_tokens = ?5, updated_at = ?6
      WHERE task_id = ?1 AND run_id = ?2 AND reservation_id = ?3 AND status = 'reserved'
    `).bind(claims.taskId, claims.runId, reservationId, status, usageTokens, now),
    db.prepare(`
      UPDATE ladder_budget_tasks SET reserved_tokens = reserved_tokens - ?3, spent_tokens = spent_tokens + ?4, updated_at = ?5
      WHERE task_id = ?1 AND run_id = ?2 AND reserved_tokens >= ?3 AND changes() = 1
    `).bind(claims.taskId, claims.runId, row.reserved_tokens, charged, now),
  ]);
  if (results.some((result) => result?.meta?.changes !== 1)) throw new Error('budget reconciliation conflict');
  return { status, chargedTokens: charged };
}

export async function createBudgetTask(db, claims) {
  if (!db || typeof db.prepare !== 'function') throw new Error('budget ledger unavailable');
  await db.prepare(`
    INSERT INTO ladder_budget_tasks (task_id, run_id, policy_id, max_tokens, reserved_tokens, spent_tokens, status, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, 0, 0, 'active', ?5, ?5)
    ON CONFLICT(task_id, run_id) DO NOTHING
  `).bind(claims.taskId, claims.runId, claims.policyId, claims.maxTokens, Date.now()).run();
  const row = await db.prepare('SELECT policy_id, max_tokens, status FROM ladder_budget_tasks WHERE task_id = ?1 AND run_id = ?2')
    .bind(claims.taskId, claims.runId).first();
  if (!row || row.policy_id !== claims.policyId || row.max_tokens !== claims.maxTokens || row.status !== 'active') throw new Error('budget task conflicts with existing policy');
  return row;
}

export async function reserveProviderAttempt(db, claims, body, outputTokens, reservationId = crypto.randomUUID()) {
  if (!Number.isSafeInteger(outputTokens) || outputTokens <= 0) throw new Error('provider output cap is unavailable');
  const estimate = estimateBudgetInput(body);
  if (!estimate.ok) return { reserved: false, reason: estimate.reason, estimate };
  const amount = estimate.estimatedTokens + outputTokens;
  const reservation = await reserveTokenBudget(db, claims, reservationId, amount);
  return { ...reservation, estimate, outputTokens, amount };
}

export async function reconcileProviderAttempt(db, claims, reservationId, usage) {
  const input = usage?.prompt_tokens;
  const output = usage?.completion_tokens;
  if (!Number.isSafeInteger(input) || input < 0 || !Number.isSafeInteger(output) || output < 0) {
    return reconcileTokenBudget(db, claims, reservationId, null, 'unknown');
  }
  return reconcileTokenBudget(db, claims, reservationId, input + output, 'settled');
}
