import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CONTEXT,
  RateWindow,
  classify,
  contextCheck,
  createZenClient,
  slimTool,
  aggregateSse,
  loadState,
  estTokens,
  parseArgs,
} from '../scripts/zen-client.mjs';

const SSE = [
  'data: {"id":"c1","model":"mimo-v2.6-flash-free","created":1,"choices":[{"index":0,"delta":{"content":"Hel"}}]}',
  '',
  'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":null}]}',
  '',
  'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":2,"total_tokens":9}}',
  '',
  'data: [DONE]',
  '',
].join('\n');

const ok = (body = SSE, status = 200, headers = {}) => () =>
  Promise.resolve(new Response(body, { status, headers }));

function fakeClient(overrides = {}) {
  const calls = [];
  const inner = overrides.fetchImpl || ok();
  const state = { now: 1_700_000_000_000 };
  const client = createZenClient({
    ...overrides,
    sleep: async ms => { state.now += ms; },
    now: () => state.now,
    fetchImpl: (url, init) => { calls.push({ url, init }); return inner(url, init); },
  });
  return { client, calls, state };
}

const ping = [{ role: 'user', content: 'ping' }];

test('cap table keeps the floor for an unstable model, never the maximum', () => {
  assert.equal(CONTEXT['big-pickle'], 262139, 'big-pickle balances over 262139 and >=1M backends — promise the floor');
  assert.equal(CONTEXT['mimo-v2.6-flash-free'], 1048576);
  assert.equal(CONTEXT['nemotron-3.5-lightning-free'], 1000000);
});

test('unknown model is passed through instead of guessed at', () => {
  const r = contextCheck('deepseek-v4-flash-free', ping, 1500);
  assert.equal(r.ok, true);
  assert.equal(r.unknown, true, 'no measured cap → the server decides, we do not invent one');
});

test('context check counts input + max_tokens against the cap', () => {
  const big = 'x'.repeat(1_000_000);
  const over = contextCheck('big-pickle', [{ role: 'user', content: big }], 1500);
  assert.equal(over.ok, false);
  assert.equal(over.cap, 262139);
  assert.ok(over.over > 0);

  const fits = contextCheck('mimo-v2.6-flash-free', [{ role: 'user', content: big }], 1500);
  assert.equal(fits.ok, true, 'the same prompt fits a 1M model');
  assert.ok(estTokens(big) > 262139, 'one prompt that is over the floor model and under the 1M one');
});

test('classify separates signature, limit and error', () => {
  assert.equal(classify(403, new Headers(), 'FreeTierError').kind, 'fingerprint', '403 is our bug, never a limit');
  assert.equal(classify(500, new Headers(), 'boom').kind, 'error');
  assert.equal(classify(500, new Headers(), 'boom').retryable, true);
  assert.equal(classify(400, new Headers(), 'Input token count exceeds').retryable, false);
});

test('429 with retry-after is the zen daily quota, without it is the provider rate', () => {
  const daily = classify(429, new Headers({ 'retry-after': '3600' }), '');
  assert.equal(daily.kind, 'daily');
  assert.equal(daily.retryAfterSec, 3600);

  const provider = classify(429, new Headers(), 'Error from provider (Console)');
  assert.equal(provider.kind, 'provider');

  assert.equal(classify(429, new Headers(), 'Rate limit exceeded').kind, 'rate');
});

test('a non-numeric retry-after is treated as absent, never as NaN in a Date', () => {
  const r = classify(429, new Headers({ 'retry-after': 'soon' }), '');
  assert.equal(r.kind, 'rate');
  assert.equal(r.retryAfterSec, undefined);
});

test('rate window never lets more than perMin through a sliding 60s', async () => {
  const perMin = 80;
  const w = new RateWindow(perMin);
  let now = 1_700_000_000_000;
  const taken = [];
  for (let i = 0; i < 400; i++) {
    const r = await w.wait(async ms => { now += ms; }, now);
    taken.push(r.at);
  }
  assert.equal(taken.length, 400);
  let peak = 0;
  for (const t of taken) {
    const inWindow = taken.filter(x => x >= t && x < t + 60_000).length;
    if (inWindow > peak) peak = inWindow;
  }
  assert.ok(peak <= perMin, `peak of the sliding window was ${peak}, limit is ${perMin}`);
  assert.ok(taken.at(-1) - taken[0] >= 60_000, '400 calls at 80/min cannot finish inside one window');
});

test('a 200 SSE reply is folded into one chat.completion', async () => {
  const { client } = fakeClient();
  const r = await client.chat({ model: 'mimo-v2.6-flash-free', messages: ping });
  assert.equal(r.ok, true);
  assert.equal(r.message.content, 'Hello');
  assert.equal(r.finish_reason, 'stop');
  assert.deepEqual(r.usage, { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 });
});

test('aggregateSse merges tool_call fragments by index', () => {
  const out = aggregateSse([
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"t1","function":{"name":"shell","arguments":"{\\"c"}}]}}]}',
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"md\\":\\"ls\\"}"}}]},"finish_reason":"tool_calls"}]}',
    'data: [DONE]',
  ].join('\n'));
  assert.equal(out.choices[0].message.tool_calls[0].function.name, 'shell');
  assert.equal(out.choices[0].message.tool_calls[0].function.arguments, '{"cmd":"ls"}');
  assert.equal(out.choices[0].finish_reason, 'tool_calls');
});

test('the request carries the fingerprint zen demands', async () => {
  const { client, calls } = fakeClient();
  await client.chat({ model: 'mimo-v2.6-flash-free', messages: ping });
  const h = calls[0].init.headers;
  const body = JSON.parse(calls[0].init.body);
  assert.match(h['user-agent'], /^opencode\//);
  assert.match(h['x-opencode-session'], /^ses_[0-9a-f]{12}[a-z0-9]{14}$/);
  assert.match(h['x-opencode-request'], /^msg_[0-9a-f]{12}[a-z0-9]{12}$/);
  assert.equal(body.stream, true, 'stream:false is a 403');
  const names = body.tools.map(t => t.function.name);
  assert.deepEqual(names.sort(), ['read', 'shell'], 'zen 403s unless both names are present');
});

test('caller tools are merged, not replaced, and never duplicated by name', async () => {
  const { client, calls } = fakeClient();
  await client.chat({ model: 'mimo-v2.6-flash-free', messages: ping, tools: [{ type: 'function', function: { name: 'search', parameters: {} } }] });
  const body = JSON.parse(calls[0].init.body);
  const names = body.tools.map(t => t.function.name);
  assert.deepEqual(names.sort(), ['read', 'search', 'shell']);
  assert.equal(body.tool_choice, undefined, 'only when the caller sent no tools at all');
});

test('daily budget stops the run BEFORE the request leaves the process', async () => {
  const { client, calls } = fakeClient({ dailyBudget: 5 });
  for (let i = 0; i < 5; i++) assert.equal((await client.chat({ model: 'big-pickle', messages: ping })).ok, true);
  const sixth = await client.chat({ model: 'big-pickle', messages: ping });
  assert.equal(sixth.ok, false);
  assert.equal(sixth.kind, 'cooldown');
  assert.equal(sixth.stoppedBy, 'local-budget');
  assert.equal(calls.length, 5, 'the 6th call must not reach the network');
  assert.equal(client.summary().byModel['big-pickle'].stoppedBy, 'local-budget');
});

test('a remote daily quota short-circuits every later call on that model only', async () => {
  let n = 0;
  const { client, calls, state } = fakeClient({
    fetchImpl: () => {
      n++;
      return n === 1
        ? Promise.resolve(new Response('', { status: 429, headers: { 'retry-after': '900' } }))
        : ok()();
    },
  });
  const first = await client.chat({ model: 'nemotron-3.5-lightning-free', messages: ping });
  assert.equal(first.kind, 'daily');
  assert.equal(first.retryAfterSec, 900);
  assert.equal(first.cooldownUntil, state.now + 900_000, 'cooldownUntil = now + retry-after');
  assert.equal(first.stoppedBy, 'remote-daily');

  const blocked = await client.chat({ model: 'nemotron-3.5-lightning-free', messages: ping });
  assert.equal(blocked.kind, 'cooldown');
  assert.equal(blocked.stoppedBy, 'remote-daily');
  assert.equal(calls.length, 1, 'cooldown is a local short-circuit, not a request');

  const other = await client.chat({ model: 'mimo-v2.6-flash-free', messages: ping });
  assert.equal(other.ok, true, 'one model in cooldown must not silence another (spec §12.11)');
});

test('403 is reported as a broken fingerprint and sets no cooldown', async () => {
  const { client } = fakeClient({ fetchImpl: () => Promise.resolve(new Response('FreeTierError', { status: 403 })) });
  const r = await client.chat({ model: 'mimo-v2.6-flash-free', messages: ping });
  assert.equal(r.kind, 'fingerprint');
  const s = client.state().models['mimo-v2.6-flash-free'];
  assert.equal(s.cooldownUntil, 0, 'a 403 is our bug — cooling down would hide it');
  assert.equal(s.limited, 0, 'and it is not a quota event');
});

test('a provider 429 parks the model for providerCooldownMs', async () => {
  const { client } = fakeClient({
    providerCooldownMs: 7200_000,
    fetchImpl: () => Promise.resolve(new Response('Error from provider (Console)', { status: 429 })),
  });
  const r = await client.chat({ model: 'big-pickle', messages: ping });
  assert.equal(r.kind, 'provider');
  assert.equal(r.stoppedBy, 'remote-provider');
  assert.equal(r.cooldownUntil, client.state().models['big-pickle'].cooldownUntil);
});

test('a 5xx is a retryable error and leaves the quota alone', async () => {
  const { client } = fakeClient({ fetchImpl: () => Promise.resolve(new Response('oops', { status: 503 })) });
  const r = await client.chat({ model: 'mimo-v2.5-free', messages: ping });
  assert.equal(r.kind, 'error');
  assert.equal(r.retryable, true);
  assert.equal(client.state().models['mimo-v2.5-free'].cooldownUntil, 0);
});

test('a prompt over the cap is refused without a request and without a cooldown', async () => {
  const { client, calls } = fakeClient();
  const huge = 'x'.repeat(1_000_000);
  const r = await client.chat({ model: 'big-pickle', messages: [{ role: 'user', content: huge }] });
  assert.equal(r.kind, 'context');
  assert.equal(r.cap, 262139);
  assert.ok(r.over > 0);
  assert.equal(calls.length, 0);
  const s = client.state().models['big-pickle'];
  assert.equal(s.cooldownUntil, 0, 'context is not a limit');
  assert.equal(s.stoppedBy, null, 'and stoppedBy does not count it');
  assert.equal(s.contextSkips, 1);
});

test('truncate drops the oldest non-system messages and says so', async () => {
  const { client, calls } = fakeClient({ truncate: true });
  const filler = 'x'.repeat(1_000_000);
  const r = await client.chat({
    model: 'big-pickle',
    maxTokens: 1000,
    messages: [{ role: 'system', content: 'keep me' }, { role: 'user', content: filler }, { role: 'assistant', content: filler }],
  });
  assert.equal(r.ok, true);
  assert.ok(r.truncatedMessages >= 1, 'the job must be able to report a shortened prompt');
  assert.equal(JSON.parse(calls[0].init.body).messages[0].role, 'system', 'the system message is never dropped');
});

test('rate governor gives each model its own window', async () => {
  const { client } = fakeClient({ ratePerMin: 2 });
  await client.chat({ model: 'mimo-v2.6-flash-free', messages: ping });
  await client.chat({ model: 'mimo-v2.6-flash-free', messages: ping });
  await client.chat({ model: 'big-pickle', messages: ping });
  assert.equal(client.summary().byModel['mimo-v2.6-flash-free'].calls, 2);
  assert.equal(client.summary().byModel['big-pickle'].calls, 1);
  assert.equal(client.summary().byModel['big-pickle'].ok, 1);
});

test('a full rate window can fail fast instead of blocking (local-rate)', async () => {
  const { client, calls } = fakeClient({ ratePerMin: 1, rateWaitMaxMs: 1000 });
  await client.chat({ model: 'mimo-v2.6-flash-free', messages: ping });
  const r = await client.chat({ model: 'mimo-v2.6-flash-free', messages: ping });
  assert.equal(r.kind, 'cooldown');
  assert.equal(r.stoppedBy, 'local-rate');
  assert.equal(calls.length, 1);
});

test('state() and summary() are per model and report stoppedBy honestly', async () => {
  const { client } = fakeClient({ dailyBudget: 1 });
  await client.chat({ model: 'big-pickle', messages: ping });
  await client.chat({ model: 'big-pickle', messages: ping });
  await client.chat({ model: 'mimo-v2.6-flash-free', messages: ping });
  const st = client.state();
  assert.equal(st.models['big-pickle'].calls, 1);
  assert.equal(st.models['big-pickle'].stoppedBy, 'local-budget');
  assert.equal(st.models['mimo-v2.6-flash-free'].stoppedBy, null);
  const sum = client.summary();
  assert.deepEqual(Object.keys(sum.byModel).sort(), ['big-pickle', 'mimo-v2.6-flash-free']);
  assert.equal(sum.byModel['big-pickle'].calls, 1);
  assert.equal(sum.byModel['big-pickle'].ok, 1);
  assert.equal(sum.byModel['big-pickle'].limited, 0);
});

test('a limited cell is never counted as a quality failure', async () => {
  const { client } = fakeClient({ fetchImpl: () => Promise.resolve(new Response('', { status: 429, headers: { 'retry-after': '60' } })) });
  await client.chat({ model: 'big-pickle', messages: ping });
  const s = client.summary().byModel['big-pickle'];
  assert.equal(s.ok, 0);
  assert.equal(s.limited, 1, '429 is «not measured», which stoppedBy/reporting carries — not a failed call');
});

test('state survives a fixed egress: same day continues, new day resets', () => {
  const file = path.join(os.tmpdir(), `zen-state-${process.pid}.json`);
  fs.writeFileSync(file, JSON.stringify({ day: '2026-10-03', models: { 'big-pickle': { calls: 799, cooldownUntil: 0 } } }));
  const sameDay = loadState(file, Date.parse('2026-10-03T22:00:00Z'));
  assert.equal(sameDay.models['big-pickle'].calls, 799);

  const nextDay = loadState(file, Date.parse('2026-10-04T00:10:00Z'));
  assert.deepEqual(nextDay.models, {}, 'a new UTC day resets the counters');
  fs.unlinkSync(file);
});

test('a carried cooldown from a previous run blocks the first call', async () => {
  const until = Date.parse('2026-10-03T23:30:00Z');
  const { client, calls } = fakeClient({ state: { day: '2026-10-03', models: { 'big-pickle': { calls: 10, cooldownUntil: until } } } });
  const r = await client.chat({ model: 'big-pickle', messages: ping });
  assert.equal(r.kind, 'cooldown');
  assert.equal(calls.length, 0);
});

test('no model means no request — the limit is per model, so it is not optional', async () => {
  const { client, calls } = fakeClient();
  const r = await client.chat({ messages: ping });
  assert.equal(r.ok, false);
  assert.equal(calls.length, 0);
});
test('parseArgs: a flag with no value is a problem, never the next flag eaten as a value', () => {
  // The exact argv a scheduled workflow run used to build: `--runs --prompt x`.
  const { values, problems } = parseArgs(['--runs', '--prompt', 'hi'], { runs: 2, prompt: '' }, { numeric: ['runs'] });
  assert.deepEqual(problems, ['--runs has no value']);
  assert.equal(values.runs, 2, 'the default survives instead of becoming NaN');
  assert.equal(values.prompt, 'hi', 'the next flag is still parsed as its own flag');
});

test('parseArgs: a non-numeric value for a numeric flag is rejected', () => {
  const { values, problems } = parseArgs(['--runs', 'abc'], { runs: 2 }, { numeric: ['runs'] });
  assert.deepEqual(problems, ['--runs must be an integer >= 1, got "abc"']);
  assert.equal(values.runs, 2);
});

test('parseArgs: a numeric flag keeps a real value, and a boolean flag takes none', () => {
  const { values, problems } = parseArgs(['--runs', '3', '--deep'], { runs: 2, deep: false }, { numeric: ['runs'] });
  assert.deepEqual(problems, []);
  assert.equal(values.runs, 3);
  assert.equal(values.deep, true);
});

test('parseArgs: a flag at the very end of argv is a problem', () => {
  const { problems } = parseArgs(['--models'], { models: '' });
  assert.deepEqual(problems, ['--models has no value']);
});

test('slimTool: длинные описания обрезаются, схема и имена сохраняются', () => {
  const big = {
    type: 'function',
    function: {
      name: 'shell',
      description: 'x'.repeat(5000),
      parameters: {
        type: 'object',
        properties: { cmd: { type: 'string', description: 'y'.repeat(5000) } },
        required: ['cmd'],
      },
    },
  };
  const out = slimTool(big);
  assert.equal(out.function.name, 'shell');
  assert.equal(out.function.description.length, 240);
  assert.equal(out.function.parameters.properties.cmd.description.length, 240);
  assert.deepEqual(out.function.parameters.required, ['cmd']);
  // короткое описание не трогаем
  const small = slimTool({ type: 'function', function: { name: 'read', description: 'short', parameters: { type: 'object', properties: {} } } });
  assert.equal(small.function.description, 'short');
});
