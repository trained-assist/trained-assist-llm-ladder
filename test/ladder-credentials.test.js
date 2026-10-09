import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getLadderCredential, readLadderToken, recoveredTokenFile } from '../scripts/ladder-credentials.mjs';
import { tokenCommand } from '../scripts/ladder-token.mjs';
import { mkdtempSync, statSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const canonical = '/test-user/agent-tokens/llm-ladder/token', legacy = '/test-user/.llm-ladder-token';
const lookup = (files = {}, env = {}) => ({ directory: '/test-user', env, read: file => {
  if (!Object.hasOwn(files, file)) throw new Error('not found'); return files[file];
} });
test('all consumers use env overrides then canonical, legacy, and local recovery sources', () => {
  const files = { [canonical]: ' canonical\n', [legacy]: 'legacy', [recoveredTokenFile]: 'recovered' };
  assert.deepEqual(getLadderCredential(lookup(files)), { token: 'canonical', source: canonical });
  assert.equal(readLadderToken(lookup(files, { LADDER_TOKEN: ' env ', LLM_LADDER_TOKEN: 'alias' })), 'env');
  assert.equal(readLadderToken(lookup(files, { LADDER_TOKEN: ' ', LLM_LADDER_TOKEN: 'alias' })), 'alias');
  assert.equal(readLadderToken(lookup({ ...files, [canonical]: '' })), 'legacy');
  assert.equal(readLadderToken(lookup({ [canonical]: ' ', [recoveredTokenFile]: 'recovered' })), 'recovered');
  assert.equal(getLadderCredential(lookup()), null);
});

function capture(extra = {}) {
  let output = '', error = '';
  return { options: { credential: { token: 'fake-sensitive-token', source: 'test-file' },
    out: s => { output += s; }, err: s => { error += s; }, ...extra },
    get output() { return output; }, get error() { return error; } };
}
test('status does not print credentials; explicit print produces only the credential', async () => {
  const normal = capture(); assert.equal(await tokenCommand([], normal.options), 0);
  assert.match(normal.output, /test-file/); assert.ok(!normal.output.includes('fake-sensitive-token'));
  const print = capture(); assert.equal(await tokenCommand(['--print'], print.options), 0);
  assert.equal(print.output, 'fake-sensitive-token\n'); assert.equal(print.error, '');
});
test('access check uses only the authenticated model-list endpoint, without exposing credentials', async () => {
  let calls = 0;
  const io = capture({ fetchImpl: async (url, opts) => {
    calls++; assert.equal(url, 'https://llm-ladder.trainedassist.store/v1/models');
    assert.equal(opts.headers.authorization, 'Bearer fake-sensitive-token');
    assert.equal(opts.method || 'GET', 'GET');
    return Response.json({ data: [{ id: 'service' }] });
  } });
  assert.equal(await tokenCommand(['--check'], io.options), 0); assert.equal(calls, 1);
  assert.match(io.output, /access OK/); assert.ok(!io.output.includes('fake-sensitive-token'));
});
test('rejected or unreachable credentials are errors and never saved', async () => {
  for (const fetchImpl of [async () => new Response('denied', { status: 401 }), async () => { throw new Error('failure'); }]) {
    let saved = false; const io = capture({ fetchImpl, save: () => { saved = true; } });
    assert.equal(await tokenCommand(['--save'], io.options), 1); assert.equal(saved, false);
    assert.ok(!io.error.includes('fake-sensitive-token'));
  }
});
test('save verifies before copying a recovered token into the canonical location', async () => {
  let verified = false, saved = false;
  const io = capture({ destination: canonical, fetchImpl: async () => { verified = true; return Response.json({ data: [{ id: 'service' }] }); },
    save: (file, token) => { assert.ok(verified); assert.equal(file, canonical); assert.equal(token, 'fake-sensitive-token'); saved = true; } });
  assert.equal(await tokenCommand(['--save'], io.options), 0); assert.ok(saved);
  assert.ok(!io.output.includes('fake-sensitive-token'));
});
test('saved credentials have owner-only permissions and preserve the value', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ladder-credential-test-'));
  try {
    const destination = join(directory, 'agent-tokens/llm-ladder/token');
    const io = capture({ destination, fetchImpl: async () => Response.json({ data: [{ id: 'service' }] }) });
    assert.equal(await tokenCommand(['--save'], io.options), 0);
    assert.equal(readFileSync(destination, 'utf8'), 'fake-sensitive-token\n');
    assert.equal(statSync(destination).mode & 0o777, 0o600);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('missing credentials and unsupported flags fail without printing sensitive arguments', async () => {
  const missing = capture({ credential: null }); assert.equal(await tokenCommand(['--print'], missing.options), 2);
  assert.equal(missing.output, ''); assert.match(missing.error, /No Ladder token/);
  const flags = capture(); assert.equal(await tokenCommand(['--token=fake-sensitive-token'], flags.options), 2);
  assert.ok(!flags.error.includes('fake-sensitive-token'));
});
