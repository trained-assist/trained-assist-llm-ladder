// Tests for scripts/runner-sandbox-key.mjs — the static Runner sandbox key (Epic #253).
//
// The script is the operator path for one permanent Ladder key that the Runner
// sandbox Worker carries as its LLM_LADDER_TOKEN secret. These tests pin the two
// properties that matter: the raw key never leaves the protected file, and the
// key is issued once and then reused instead of being re-issued per run.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  keyId,
  parseArgs,
  provision,
  verify,
  writeKeyFile,
} from '../scripts/runner-sandbox-key.mjs'

const RAW = 'sandbox-key-value-0123456789'
const ADMIN = 'admin-token-value'
const USER = 'ai-agent-runner-sandbox'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'ladder-sandbox-key-'))
}

function captureOut() {
  const lines = []
  return { out: (line) => lines.push(line), get text() { return lines.join('\n') } }
}

/** Minimal Ladder admin API double. `state` is mutated by the handlers below. */
function adminApi(state = {}) {
  const users = state.users ?? []
  const keys = state.keys ?? []
  const calls = []
  const fetchImpl = async (url, opts = {}) => {
    const path = new URL(url).pathname + new URL(url).search
    const method = opts.method || 'GET'
    calls.push(`${method} ${path}`)
    const auth = opts.headers?.authorization
    if (auth !== `Bearer ${ADMIN}` && !(path.startsWith('/v1/chat/completions') && auth === `Bearer ${RAW}`)) {
      return Response.json({ error: { message: 'unauthorized' } }, { status: 401 })
    }
    if (path === '/v1/admin/users' && method === 'GET') {
      return Response.json({ users })
    }
    if (path === '/v1/admin/users' && method === 'POST') {
      const body = JSON.parse(opts.body)
      users.push({ user_id: body.user_id, email: body.email, role: body.role, status: 'active' })
      keys.push({ key_id: keyId(RAW), user_id: body.user_id, label: body.label, status: 'active', revoked_at: null })
      return Response.json({ user: { user_id: body.user_id }, token: RAW, label: body.label }, { status: 201 })
    }
    if (path === '/v1/admin/keys' && method === 'GET') {
      return Response.json({ keys })
    }
    if (path.startsWith('/v1/users/') && path.endsWith('/tokens') && method === 'POST') {
      return Response.json({ user_id: USER, token: RAW, label: 'ai-agent-runner-sandbox' }, { status: 201 })
    }
    if (/^\/v1\/admin\/keys\/[0-9a-f]{16}\/revoke$/.test(path) && method === 'POST') {
      const id = path.split('/')[4]
      const key = keys.find((k) => k.key_id === id)
      if (key) { key.status = 'revoked'; key.revoked_at = Date.now() }
      return Response.json({ key_id: id, status: 'revoked' })
    }
    if (path === '/v1/chat/completions' && method === 'POST') {
      return Response.json({ model: 'openrouter/nvidia/nemotron-3-ultra-550b-a55b:free', usage: { prompt_tokens: 17, completion_tokens: 32 } })
    }
    if (path.startsWith('/v1/admin/key-usage')) {
      return Response.json({ rows: [{ key_id: keyId(RAW), key_label: 'ai-agent-runner-sandbox', key_status: 'active', user_id: USER, app: null, model: 'free-model', tier: 'free', calls: 2, successful: 2, failed: 0 }] })
    }
    if (path.startsWith('/v1/calls')) {
      return Response.json({ count: 1, calls: [{ ts: Date.now(), run_id: 'run_abc', trace_id: 'run_abc', session_id: 'ses_x', ladder: 'free', ok: true, model: 'free-model' }] })
    }
    return Response.json({ error: { message: `not found: ${path}` } }, { status: 404 })
  }
  return { fetchImpl, calls, users, keys }
}

test('key id is the sha256 prefix of the key and never the key itself', () => {
  const id = keyId(RAW)
  assert.equal(id.length, 16)
  assert.match(id, /^[0-9a-f]{16}$/)
  assert.ok(!id.includes(RAW))
  assert.notEqual(id, RAW)
})

test('parseArgs reads flags and positionals without leaking values into flags', () => {
  const args = parseArgs(['verify', '--key-file', '/tmp/k', '--rotate', '--admin-token-file', '/tmp/a'])
  assert.deepEqual(args._, ['verify'])
  assert.equal(args['key-file'], '/tmp/k')
  assert.equal(args.rotate, true)
  assert.equal(args['admin-token-file'], '/tmp/a')
})

test('the protected key file is written 0600 and a different value is never overwritten silently', () => {
  const dir = tempDir()
  const file = join(dir, 'nested', 'key')
  assert.equal(writeKeyFile(file, RAW), 'written')
  assert.equal(statSync(file).mode & 0o777, 0o600)
  assert.equal(readFileSync(file, 'utf8').trim(), RAW)
  assert.equal(writeKeyFile(file, RAW), 'unchanged')
  assert.throws(() => writeKeyFile(file, 'another-value'), /refusing to overwrite/)
  assert.equal(readFileSync(file, 'utf8').trim(), RAW)
  assert.equal(writeKeyFile(file, 'another-value', { force: true }), 'written')
  assert.equal(statSync(file).mode & 0o777, 0o600)
})

test('provision creates the user and its first key, stores it 0600 and prints no key material', async () => {
  const dir = tempDir()
  const keyFile = join(dir, 'ai-agent-runner-sandbox')
  const adminFile = join(dir, 'admin')
  writeFileSync(adminFile, ADMIN)
  const api = adminApi()
  const io = captureOut()
  const result = await provision({
    args: { 'key-file': keyFile, 'admin-token-file': adminFile },
    fetchImpl: api.fetchImpl,
    out: io.out,
  })
  assert.equal(result.action, 'user+key created')
  assert.equal(result.keyId, keyId(RAW))
  assert.equal(readFileSync(keyFile, 'utf8').trim(), RAW)
  assert.equal(statSync(keyFile).mode & 0o777, 0o600)
  assert.ok(io.text.includes(keyId(RAW)))
  assert.ok(!io.text.includes(RAW))
  assert.ok(!io.text.includes(ADMIN))
  assert.ok(api.calls.some((c) => c === 'POST /v1/admin/users'))
})

test('provision is idempotent: an existing user, key and file are reused, nothing is re-issued', async () => {
  const dir = tempDir()
  const keyFile = join(dir, 'ai-agent-runner-sandbox')
  const adminFile = join(dir, 'admin')
  writeFileSync(adminFile, ADMIN)
  writeFileSync(keyFile, RAW)
  const api = adminApi({
    users: [{ user_id: USER, email: 'x@test.invalid', role: 'user', status: 'active' }],
    keys: [{ key_id: keyId(RAW), user_id: USER, label: 'ai-agent-runner-sandbox', status: 'active', revoked_at: null }],
  })
  const io = captureOut()
  const result = await provision({
    args: { 'key-file': keyFile, 'admin-token-file': adminFile },
    fetchImpl: api.fetchImpl,
    out: io.out,
  })
  assert.equal(result.action, 'reused: user, key and protected file already in place')
  assert.equal(result.fileState, 'unchanged')
  assert.ok(!api.calls.some((c) => c.startsWith('POST /v1/admin/users')))
  assert.ok(!api.calls.some((c) => c.includes('/tokens')))
  assert.ok(!io.text.includes(RAW))
})

test('provision refuses to overwrite a protected file that holds a different key', async () => {
  const dir = tempDir()
  const keyFile = join(dir, 'ai-agent-runner-sandbox')
  const adminFile = join(dir, 'admin')
  writeFileSync(adminFile, ADMIN)
  writeFileSync(keyFile, 'some-other-key')
  const api = adminApi({
    users: [{ user_id: USER, email: 'x@test.invalid', role: 'user', status: 'active' }],
    keys: [{ key_id: keyId(RAW), user_id: USER, label: 'ai-agent-runner-sandbox', status: 'active', revoked_at: null }],
  })
  await assert.rejects(() => provision({
    args: { 'key-file': keyFile, 'admin-token-file': adminFile },
    fetchImpl: api.fetchImpl,
    out: () => {},
  }), /rotate explicitly/)
  assert.equal(readFileSync(keyFile, 'utf8').trim(), 'some-other-key')
})

test('an explicit rotation issues a new key and revokes the previous one', async () => {
  const dir = tempDir()
  const keyFile = join(dir, 'ai-agent-runner-sandbox')
  const adminFile = join(dir, 'admin')
  writeFileSync(adminFile, ADMIN)
  const api = adminApi({
    users: [{ user_id: USER, email: 'x@test.invalid', role: 'user', status: 'active' }],
    keys: [{ key_id: 'aaaaaaaaaaaaaaaa', user_id: USER, label: 'ai-agent-runner-sandbox', status: 'active', revoked_at: null }],
  })
  const io = captureOut()
  const result = await provision({
    args: { 'key-file': keyFile, 'admin-token-file': adminFile, rotate: true },
    fetchImpl: api.fetchImpl,
    out: io.out,
  })
  assert.equal(result.action, 'key rotated')
  assert.equal(result.revokedKeyId, 'aaaaaaaaaaaaaaaa')
  assert.ok(api.calls.includes('POST /v1/users/ai-agent-runner-sandbox/tokens'))
  assert.ok(api.calls.includes('POST /v1/admin/keys/aaaaaaaaaaaaaaaa/revoke'))
  assert.ok(!io.text.includes(RAW))
})

test('verify proves the key, its owner and the analytics attribution, and prints no key material', async () => {
  const dir = tempDir()
  const keyFile = join(dir, 'ai-agent-runner-sandbox')
  const adminFile = join(dir, 'admin')
  writeFileSync(adminFile, ADMIN)
  writeFileSync(keyFile, RAW)
  const api = adminApi({
    users: [{ user_id: USER, email: 'x@test.invalid', role: 'user', status: 'active' }],
    keys: [{ key_id: keyId(RAW), user_id: USER, label: 'ai-agent-runner-sandbox', status: 'active', revoked_at: null }],
  })
  const io = captureOut()
  const report = await verify({
    args: { 'key-file': keyFile, 'admin-token-file': adminFile },
    fetchImpl: api.fetchImpl,
    out: io.out,
  })
  assert.equal(report.call.ok, true)
  assert.equal(report.key.user_id, USER)
  assert.equal(report.attribution.rows[0].user_id, USER)
  assert.equal(report.sandbox_calls.count, 1)
  assert.ok(io.text.includes(keyId(RAW)))
  assert.ok(!io.text.includes(RAW))
  assert.ok(!io.text.includes(ADMIN))
})

test('verify fails when Ladder analytics does not attribute any call to the key', async () => {
  const dir = tempDir()
  const keyFile = join(dir, 'ai-agent-runner-sandbox')
  const adminFile = join(dir, 'admin')
  writeFileSync(adminFile, ADMIN)
  writeFileSync(keyFile, RAW)
  const api = adminApi({
    users: [{ user_id: USER, email: 'x@test.invalid', role: 'user', status: 'active' }],
    keys: [{ key_id: keyId(RAW), user_id: USER, label: 'ai-agent-runner-sandbox', status: 'active', revoked_at: null }],
  })
  const fetchImpl = async (url, opts = {}) => {
    if (String(url).includes('/v1/admin/key-usage')) return Response.json({ rows: [] })
    return api.fetchImpl(url, opts)
  }
  await assert.rejects(() => verify({
    args: { 'key-file': keyFile, 'admin-token-file': adminFile },
    fetchImpl,
    out: () => {},
  }), /did not attribute any call/)
})

test('verify fails when the bounded probe call is rejected', async () => {
  const dir = tempDir()
  const keyFile = join(dir, 'ai-agent-runner-sandbox')
  writeFileSync(keyFile, RAW)
  const fetchImpl = async () => Response.json({ error: { message: 'unauthorized' } }, { status: 401 })
  await assert.rejects(() => verify({
    args: { 'key-file': keyFile },
    fetchImpl,
    out: () => {},
  }), /probe call failed/)
})

test('the key file is the only place the raw key lives', async () => {
  const dir = tempDir()
  const keyFile = join(dir, 'ai-agent-runner-sandbox')
  const adminFile = join(dir, 'admin')
  writeFileSync(adminFile, ADMIN)
  const api = adminApi()
  const io = captureOut()
  await provision({
    args: { 'key-file': keyFile, 'admin-token-file': adminFile },
    fetchImpl: api.fetchImpl,
    out: io.out,
  })
  assert.ok(existsSync(keyFile))
  assert.ok(!io.text.includes(RAW))
})
