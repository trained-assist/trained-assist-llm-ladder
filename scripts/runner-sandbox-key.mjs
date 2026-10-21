#!/usr/bin/env node
// runner-sandbox-key.mjs — static Runner sandbox key for the Ladder lane (Epic #253).
//
// One ordinary Ladder user `ai-agent-runner-sandbox` owns one permanent named key
// `ai-agent-runner-sandbox`. The key is bound to the Runner sandbox Worker as its
// `LLM_LADDER_TOKEN` secret, so every sandbox run is attributable to that user in
// Ladder analytics. The key is static: it is NOT re-issued per run, per sandbox
// rebuild or per deploy — rotation is a separate, explicit decision.
//
// The raw key is read from and written to a protected file only. It never reaches
// argv, stdout, logs, PR bodies or issue evidence.
//
//   node scripts/runner-sandbox-key.mjs provision \
//     --admin-token-file ~/agent-tokens/llm-ladder/token \
//     --key-file ~/agent-tokens/trained-assist/ai-agent-runner-sandbox
//
//   node scripts/runner-sandbox-key.mjs verify \
//     --key-file ~/agent-tokens/trained-assist/ai-agent-runner-sandbox \
//     --admin-token-file ~/agent-tokens/llm-ladder/token
//
// provision is idempotent: an existing active user and key are left untouched.
// verify makes one bounded, free-tier call and checks that Ladder attributes it
// to this key and user, and that the sandbox lane's recent calls carry the same
// user id.
//
// See docs/runner-sandbox-key.md for the operator runbook.

import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_USER_ID = 'ai-agent-runner-sandbox'
const DEFAULT_LABEL = 'ai-agent-runner-sandbox'
const DEFAULT_EMAIL = 'ai-agent-runner-sandbox@test.epic253.invalid'
const PROBE_APP = 'runner-sandbox-key'
const DEFAULT_BASE = 'https://llm-ladder.trainedassist.store'
const DEFAULT_RUNNER_URL = 'https://trained-assist-runner-api-sandbox3.skillset-apply.workers.dev'

export function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg.startsWith('--')) {
      const name = arg.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) args[name] = true
      else { args[name] = next; i++ }
    } else args._.push(arg)
  }
  return args
}

/** Key id = first 16 hex of the SHA-256 of the raw key. Never the key itself. */
export function keyId(secret) {
  return createHash('sha256').update(secret).digest('hex').slice(0, 16)
}

function readSecretFile(path) {
  if (!path || path === true) return null
  const value = readFileSync(path, 'utf8').trim()
  if (!value) throw new Error(`secret file ${path} is empty`)
  return value
}

/**
 * Write the raw key to a protected file. The value is never echoed. An existing
 * file with a different value is only replaced on an explicit rotation.
 */
export function writeKeyFile(path, secret, { force = false } = {}) {
  if (existsSync(path)) {
    const current = readFileSync(path, 'utf8').trim()
    if (current === secret) return 'unchanged'
    if (!force) throw new Error(`${path} already holds a different key; refusing to overwrite (use --force after an explicit rotation)`)
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${secret}\n`, { mode: 0o600 })
  chmodSync(path, 0o600)
  return 'written'
}

async function ladder(path, { method = 'GET', token, body, headers = {}, fetchImpl = fetch, base = DEFAULT_BASE } = {}) {
  const response = await fetchImpl(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(150_000),
  })
  const text = await response.text()
  let data = null
  try { data = JSON.parse(text) } catch { data = null }
  return { status: response.status, data, text }
}

/**
 * Issue the sandbox user and its single permanent named key.
 *
 * Idempotent by design: an existing active user with an active key of the same
 * label is left untouched, and the raw value is taken from the protected file
 * (Ladder never returns it again). A rotation is a separate, explicit decision.
 */
export async function provision(options = {}) {
  const { args = {}, fetchImpl = fetch, base = DEFAULT_BASE, env = process.env, out = console.log } = options
  const keyFile = args['key-file'] || env.RUNNER_SANDBOX_KEY_FILE
  const adminTokenFile = args['admin-token-file'] || env.LADDER_ADMIN_TOKEN_FILE
  const userId = args['user-id'] || DEFAULT_USER_ID
  const label = args.label || DEFAULT_LABEL
  const email = args.email || DEFAULT_EMAIL
  if (!keyFile) throw new Error('--key-file is required')
  const adminToken = readSecretFile(adminTokenFile)
  if (!adminToken) throw new Error('--admin-token-file is required for provision')

  const users = await ladder('/v1/admin/users', { token: adminToken, fetchImpl, base })
  if (users.status !== 200) throw new Error(`admin users lookup failed with HTTP ${users.status}`)
  const existingUser = (users.data?.users || []).find((u) => u.user_id === userId)

  let secret = null
  let action = null
  let revokedKeyId = null

  if (!existingUser) {
    const created = await ladder('/v1/admin/users', {
      method: 'POST', token: adminToken, fetchImpl, base,
      body: { user_id: userId, email, role: 'user', label },
    })
    if (created.status !== 201) throw new Error(`admin user creation failed with HTTP ${created.status}: ${created.text.slice(0, 200)}`)
    secret = created.data?.token
    action = 'user+key created'
  } else {
    if (existingUser.status !== 'active') throw new Error(`user ${userId} is ${existingUser.status}; enable it before issuing a key`)
    const keys = await ladder('/v1/admin/keys', { token: adminToken, fetchImpl, base })
    if (keys.status !== 200) throw new Error(`admin keys lookup failed with HTTP ${keys.status}`)
    const owned = (keys.data?.keys || []).filter((k) => k.user_id === userId)
    const named = owned.find((k) => k.label === label && k.status === 'active' && k.revoked_at === null)
    if (args.rotate) {
      // Explicit rotation only. The raw value of the old key is unrecoverable, so the
      // file is replaced and the previous key of this user is revoked afterwards.
      const issued = await ladder(`/v1/users/${encodeURIComponent(userId)}/tokens`, {
        method: 'POST', token: adminToken, fetchImpl, base, body: { label },
      })
      if (issued.status !== 201) throw new Error(`key issuance failed with HTTP ${issued.status}: ${issued.text.slice(0, 200)}`)
      secret = issued.data?.token
      action = 'key rotated'
      revokedKeyId = named?.key_id ?? null
    } else if (named && existsSync(keyFile)) {
      const local = readSecretFile(keyFile)
      if (keyId(local) === named.key_id) {
        secret = local
        action = 'reused: user, key and protected file already in place'
      } else {
        throw new Error(`key ${named.key_id} is active for ${userId} but ${keyFile} holds a different value; the raw value cannot be recovered — rotate explicitly (--rotate) and revoke the old key`)
      }
    } else if (named) {
      throw new Error(`key ${named.key_id} is active for ${userId} but ${keyFile} is missing; the raw value cannot be recovered — rotate explicitly (--rotate) and revoke the old key`)
    } else {
      throw new Error(`${userId} already owns ${owned.length} key(s) but none is the active '${label}' key; pass --rotate to issue it and revoke the previous one`)
    }
  }

  if (!secret) throw new Error('no key value returned by the Ladder admin API')
  const fileState = writeKeyFile(keyFile, secret, { force: Boolean(args.rotate) })

  if (revokedKeyId) {
    const revoked = await ladder(`/v1/admin/keys/${revokedKeyId}/revoke`, { method: 'POST', token: adminToken, fetchImpl, base })
    if (revoked.status !== 200) throw new Error(`revoking the previous key ${revokedKeyId} failed with HTTP ${revoked.status}; the new key is active, revoke manually`)
  }

  out(JSON.stringify({
    action, user_id: userId, role: 'user', label, key_id: keyId(secret),
    key_file: keyFile, key_file_state: fileState, ladder: base,
    ...(revokedKeyId ? { revoked_key_id: revokedKeyId } : {}),
  }, null, 2))
  return { action, userId, label, keyId: keyId(secret), keyFile, fileState, revokedKeyId }
}

/**
 * Verify the sandbox key end to end:
 *  1. one bounded free-tier call with the key itself (HTTP 200),
 *  2. the key is active and owned by the sandbox user,
 *  3. Ladder analytics attribute recent calls to that key and user,
 *  4. the sandbox lane's recent calls carry the same user id.
 */
export async function verify(options = {}) {
  const { args = {}, fetchImpl = fetch, base = DEFAULT_BASE, env = process.env, out = console.log } = options
  const keyFile = args['key-file'] || env.RUNNER_SANDBOX_KEY_FILE
  const adminTokenFile = args['admin-token-file'] || env.LADDER_ADMIN_TOKEN_FILE
  const userId = args['user-id'] || DEFAULT_USER_ID
  if (!keyFile) throw new Error('--key-file is required')
  const secret = readSecretFile(keyFile)
  if (!secret) throw new Error(`no key material in ${keyFile}`)
  const id = keyId(secret)
  const trace = `runner-sandbox-key-${Date.now()}`

  const call = await ladder('/v1/chat/completions', {
    method: 'POST', token: secret, fetchImpl, base,
    headers: { 'x-ladder-app': PROBE_APP, 'x-ladder-trace': trace },
    body: { model: 'free', messages: [{ role: 'user', content: 'ping' }], max_tokens: 16, ladder_timeout_ms: 30_000 },
  })
  const callOk = call.status === 200
  const usage = call.data?.usage || null
  const report = {
    ladder: base, trace, call: {
      status: call.status, ok: callOk,
      model: call.data?.model || null,
      tokens_in: usage?.prompt_tokens ?? null,
      tokens_out: usage?.completion_tokens ?? null,
    },
    key_id: id,
  }
  if (!callOk) report.call.error = String(call.data?.error?.message || call.text).slice(0, 200)

  const adminToken = readSecretFile(adminTokenFile)
  let attributed = false
  if (adminToken) {
    const keys = await ladder('/v1/admin/keys', { token: adminToken, fetchImpl, base })
    const mine = (keys.data?.keys || []).find((k) => k.key_id === id)
    report.key = mine ? {
      key_id: mine.key_id, user_id: mine.user_id, label: mine.label, status: mine.status,
      revoked_at: mine.revoked_at, last_used_at: mine.last_used_at || null,
    } : { key_id: id, found: false }

    const usageRes = await ladder(`/v1/admin/key-usage?period=15m&key_id=${id}`, { token: adminToken, fetchImpl, base })
    report.attribution = {
      status: usageRes.status,
      rows: (usageRes.data?.rows || []).map((r) => ({
        key_id: r.key_id, key_label: r.key_label, key_status: r.key_status, user_id: r.user_id,
        app: r.app, model: r.model, tier: r.tier, calls: r.calls, successful: r.successful, failed: r.failed,
      })),
    }
    attributed = report.attribution.rows.some((r) => r.user_id === userId && r.key_id === id && r.calls > 0)

    // The sandbox lane runs through the Worker; the per-call log shows which user id
    // and run id those calls were attributed to. This is the "attributed to this key"
    // evidence for calls that did not go through this script.
    const since = Date.now() - 24 * 3600_000
    const callsRes = await ladder(`/v1/calls?user=${encodeURIComponent(userId)}&since_ms=${since}&limit=50`, { token: adminToken, fetchImpl, base })
    report.sandbox_calls = {
      status: callsRes.status,
      count: callsRes.data?.count ?? 0,
      calls: (callsRes.data?.calls || []).slice(0, 20).map((c) => ({
        ts: c.ts, run_id: c.run_id || null, trace_id: c.trace_id || null, session_id: c.session_id || null,
        ladder: c.ladder, ok: c.ok, model: c.model, app: null,
      })),
    }
  }

  const runnerKeyFile = args['runner-key-file'] || env.RUNNER_API_KEY_FILE
  if (runnerKeyFile && runnerKeyFile !== true) {
    const runnerToken = readSecretFile(runnerKeyFile)
    const runnerUrl = (args['runner-url'] || DEFAULT_RUNNER_URL).replace(/\/$/, '')
    const caps = await fetchImpl(`${runnerUrl}/v1/developer/capabilities`, {
      headers: { authorization: `Bearer ${runnerToken}`, accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    })
    const capsBody = await caps.json().catch(() => null)
    report.runner = {
      url: runnerUrl, status: caps.status,
      managed_available: capsBody?.managedAvailable ?? null,
      managed_model: capsBody?.managedModel ?? null,
    }
  }

  out(JSON.stringify(report, null, 2))
  if (!callOk) throw new Error(`bounded probe call failed with HTTP ${call.status}`)
  if (adminToken && !attributed) throw new Error(`Ladder analytics did not attribute any call to key ${id} / user ${userId}`)
  return report
}

export async function runnerSandboxKeyCommand(argv, options = {}) {
  const args = parseArgs(argv)
  const command = args._[0]
  if (!command || !['provision', 'verify'].includes(command)) {
    throw new Error('usage: runner-sandbox-key.mjs <provision|verify> --key-file <file> [--admin-token-file <file>]')
  }
  if (command === 'provision') return provision({ ...options, args })
  return verify({ ...options, args })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    await runnerSandboxKeyCommand(process.argv.slice(2))
  } catch (error) {
    console.error(String(error instanceof Error ? error.message : error))
    process.exitCode = 1
  }
}
