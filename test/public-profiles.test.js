import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { run, rungsFor } from '../src/ladder.js';
import { handle } from '../src/handler.js';
import { memoryStore } from '../src/state.js';

const read = (file) => JSON.parse(fs.readFileSync(new URL(file, import.meta.url)));
const config = read('../config/ladders.json');
const prices = read('../config/prices.json');
const names = ['standard', 'free', 'fast'];
const free = (model) => model.startsWith('zen-rings/') || model.endsWith('-free') || model.endsWith(':free');

for (const name of names) {
  test(`${name} profile routes every OpenCode role to its own ladder`, () => {
    const profile = read(`../profiles/${name}.json`);
    const model = `ladder/${name}`;
    assert.equal(profile.model, model);
    assert.equal(profile.small_model, model);
    for (const role of ['build', 'plan', 'explore', 'general', 'review']) {
      const expectedModel = name === 'standard' && role === 'plan' ? 'ladder/standard:plan' : model;
      assert.equal(profile.agent[role].model, expectedModel);
    }
    assert.deepEqual(rungsFor(config, name), config.ladders[name].build);
  });
}

test('Standard Plan has a dedicated paid-first route and is advertised as standard:plan', async () => {
  const expected = [
    'opencode-go/mimo-v2.6-flash',
    'openrouter/google/gemini-3.1-flash-lite-preview',
    'opencode-go/deepseek-v4-pro',
  ];
  assert.deepEqual(config.ladders.standard.plan, expected);
  assert.deepEqual(rungsFor(config, 'standard:plan'), expected);

  const profile = read('../profiles/standard.json');
  assert.equal(profile.agent.plan.model, 'ladder/standard:plan');

  const response = await handle(new Request('https://l.test/v1/models', {
    headers: { authorization: 'Bearer test-token' },
  }), { LADDER_TOKEN: 'test-token' }, {});
  const models = await response.json();
  assert.ok(models.data.some((model) => model.id === 'standard:plan' && model.rungs[0] === expected[0]));
});

test('only three public profile files are installed by this package', () => {
  assert.deepEqual(fs.readdirSync(new URL('../profiles/', import.meta.url)).sort(), [...names].sort().map((name) => `${name}.json`));
});

test('free is fail-closed at $0; standard is free-first with a paid reserve; fast starts paid with cache', () => {
  const standard = config.ladders.standard.build;
  const freeRungs = config.ladders.free.build;
  const fast = config.ladders.fast.build;
  assert.ok(freeRungs.length > 1);
  assert.ok(freeRungs.every(free));
  // The free ladder opens with the free Go rung (owner 2026-10-07): every rung is $0, and the
  // working rungs are zen-rings or OpenRouter. The Go rung is the deliberate head.
  assert.equal(freeRungs[0], 'opencode-go/beam-free', 'the free ladder opens with the free Go rung');
  assert.ok(freeRungs.slice(1).every((model) => model.startsWith('zen-rings/') || model.startsWith('openrouter/')),
    'every free rung after the Go head is zen-rings or OpenRouter');
  assert.ok(freeRungs.every((model) => !prices[model] || prices[model].every((amount) => amount === 0)));
  assert.ok(standard.slice(0, 5).every(free));
  assert.ok(standard.slice(5).every((model) => !free(model) && prices[model]?.[0] > 0 && prices[model]?.[1] > 0));
  assert.ok(standard.slice(5).some((model) => model.startsWith('opencode-go/')));
  assert.ok(standard.slice(5).some((model) => model.startsWith('openrouter/')));
  assert.ok(fast.every((model) => !free(model) && prices[model]?.[0] > 0 && prices[model]?.[1] > 0));
  assert.ok(fast.every((model) => prices[model]?.[2] > 0), 'paid fast rungs must report cache-read cost');
  assert.ok(fast[0].startsWith('opencode-go/'));
  assert.ok(fast.some((model) => model.startsWith('openrouter/')));
});

const env = { OPENCODE_GO_API_KEYS: 'oc_a,oc_b', OPENROUTER_API_KEY: 'or_key' };
const answer = { id: 'x', object: 'chat.completion', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 3, completion_tokens: 1 } };
const request = (model) => ({ model, messages: [{ role: 'user', content: 'synthetic profile check' }] });

async function execute(name, failAll) {
  const seen = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push({ url, model: body.model });
    const ok = !failAll && url.includes('openrouter.ai') && !body.model.endsWith(':free');
    return { ok, status: ok ? 200 : 500, json: async () => answer, text: async () => 'synthetic failure' };
  };
  const cfg = { ...config, ladders: { ...config.ladders, [name]: { build: config.ladders[name].build.filter((model) => !model.startsWith('zen-rings/')) } } };
  const result = await run(request(name), { env, config: cfg, store: memoryStore(2), fetchImpl });
  return { seen, result, rungs: cfg.ladders[name].build };
}

test('standard reaches an independent paid OpenRouter reserve after cheaper rungs fail', async () => {
  const { seen, result, rungs } = await execute('standard', false);
  assert.equal(result.ok, true);
  assert.equal(result.model, rungs.find((model) => model.startsWith('openrouter/') && !free(model)));
  assert.ok(seen.some((call) => call.url.includes('opencode.ai')));
  assert.ok(seen.some((call) => call.url.includes('openrouter.ai')));
});

test('standard:plan starts on paid Go MiMo and falls through only to its paid reserves', async () => {
  const seen = [];
  const result = await run(request('standard:plan'), {
    env, config, store: memoryStore(2),
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      seen.push({ url, model: body.model });
      return { ok: true, status: 200, json: async () => answer, text: async () => '' };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.model, 'opencode-go/mimo-v2.6-flash');
  assert.deepEqual(seen.map((call) => call.model), ['mimo-v2.6-flash']);
  assert.ok(seen[0].url.includes('/go/'));
});

test('standard:plan uses its independent paid OpenRouter reserve when Go MiMo fails', async () => {
  const seen = [];
  const result = await run(request('standard:plan'), {
    env, config, store: memoryStore(2),
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      seen.push({ url, model: body.model });
      const ok = url.includes('openrouter.ai');
      return { ok, status: ok ? 200 : 503, json: async () => answer, text: async () => 'synthetic provider failure' };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.model, 'openrouter/google/gemini-3.1-flash-lite-preview');
  assert.deepEqual(seen.map((call) => call.model), [
    'mimo-v2.6-flash',
    'mimo-v2.6-flash', // same-rung transient retry
    'google/gemini-3.1-flash-lite-preview',
  ]);
  assert.ok(seen[0].url.includes('/go/'));
  assert.ok(seen[1].url.includes('/go/'));
  assert.ok(seen[2].url.includes('openrouter.ai'));
});

test('fast exhausts explicitly and never falls into a free rung', async () => {
  const { seen, result, rungs } = await execute('fast', true);
  assert.equal(result.ok, false);
  assert.ok(seen.length > 0);
  assert.ok(seen.every((call) => rungs.some((model) => model.endsWith(call.model))));
});

test('fast sends the normal request body to its paid first rung', async () => {
  const model = config.ladders.fast.build[0];
  const messages = [{ role: 'user', content: 'synthetic ordinary request' }];
  const seen = [];
  const result = await run({ ...request('fast'), messages }, {
    env, config, store: memoryStore(2), conversation: 'profile-fast',
    fetchImpl: async (_url, init) => {
      seen.push(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => answer, text: async () => '' };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.model, model);
  assert.deepEqual(seen[0].messages, messages);
  assert.equal(Object.hasOwn(seen[0], 'ladder_cache_variant'), false);
});
