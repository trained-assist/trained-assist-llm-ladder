import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/handler.js';
import { memoryStore } from '../src/state.js';
import ladders from '../config/ladders.json' with { type: 'json' };

const rung = ladders.ladders.service.build.find(model => model.startsWith('openrouter/'));
const request = () => new Request('https://fixture.test/v1/chat/completions', {
  method: 'POST', headers: { authorization: 'Bearer fixture', 'content-type': 'application/json', 'x-ladder-trace': 'synthetic-trace' },
  body: JSON.stringify({ model: 'service', ladder_rung: rung, messages: [{ role: 'user', content: 'fixture' }] }),
});

for (const fails of [false, true]) {
  test(`slow diagnostic persistence cannot hold the completed response (write fails=${fails})`, { timeout: 2000 }, async t => {
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    t.after(release);
    const rows = [], background = [];
    const db = { prepare() { return { bind(...values) { return { async run() {
      await pending;
      if (fails) throw new Error('synthetic storage failure');
      rows.push(values);
    } }; } }; } };
    const response = await handle(request(), { LADDER_TOKEN: 'fixture', OPENROUTER_API_KEY: 'synthetic', LADDER_TRACE_DB: db }, {
      store: memoryStore(1), waitUntil: promise => background.push(promise),
      fetchImpl: async () => Response.json({ choices: [{ message: { content: 'fixture-answer' } }] }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).choices[0].message.content, 'fixture-answer');
    assert.equal(background.length, 1);
    assert.equal(rows.length, 0, 'trace write remains pending when the response is available');
    release();
    await background[0];
    assert.equal(rows.length, fails ? 0 : 1);
    if (!fails) assert.equal(rows[0][1], 'synthetic-trace');
  });
}
