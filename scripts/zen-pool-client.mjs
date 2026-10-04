#!/usr/bin/env node
// Local client for the Zen Pool control plane (fork: vovalikessmoothy-png/LLM-test, deployed to the
// same worker as this ladder). One HTTP call = one zen answer: the pool holds long-lived GitHub
// Actions runners, so a call is a queue push plus a watchdog, not a job dispatch.
//
//   node scripts/zen-pool-client.mjs health
//   node scripts/zen-pool-client.mjs pool
//   node scripts/zen-pool-client.mjs models
//   node scripts/zen-pool-client.mjs metrics
//   node scripts/zen-pool-client.mjs scale [demand]
//   node scripts/zen-pool-client.mjs call <model> [prompt] [--max-tokens N] [--wait-ms N] [--json]
//   node scripts/zen-pool-client.mjs call <model> --messages @turns.json
//   node scripts/zen-pool-client.mjs result <task_id>
//
// Token: $ZEN_RUNNER_TOKEN or ~/.llm-ladder-zen-token (chmod 600, outside the repo) — the same
// shared secret the runner uses for /zen/*. `health` and `pool` are open and work without it.
//
// A 504 from `call` is not a failure: the task stays queued and the answer lands later, so the
// client switches to the result endpoint and polls until it arrives (--poll-ms, default 120000).
//
// No dependencies (repo rule): node built-ins only.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const base = (process.env.ZEN_BASE || 'https://llm-ladder.trainedassist.store').replace(/\/$/, '');
const jsonOut = process.argv.includes('--json');

let token = process.env.ZEN_RUNNER_TOKEN;
if (!token) {
  try { token = readFileSync(join(homedir(), '.llm-ladder-zen-token'), 'utf8').trim(); } catch { /* fall through */ }
}

const argv = process.argv.slice(2).filter(a => !a.startsWith('--'));
const flag = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};

async function call(path, { method = 'GET', body, auth = true } = {}) {
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  if (auth && token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 400) }; }
  return { status: res.status, data };
}

function need(d, what) {
  if (d.error) { console.error(`error: ${d.error}${d.reason ? ` (${d.reason})` : ''}${d.hint ? `\nhint: ${d.hint}` : ''}`); process.exit(1); }
  return d;
}

function emit(d) {
  console.log(jsonOut ? JSON.stringify(d, null, 2) : JSON.stringify(d));
}

const [cmd, ...rest] = argv;

switch (cmd) {
  case 'health': {
    const { data } = await call('/zen/health', { auth: false });
    emit(data);
    break;
  }
  case 'pool': {
    const { data } = await call('/zen/pool/health', { auth: false });
    emit(data);
    break;
  }
  case 'models': {
    const { status, data } = await call('/zen/models');
    if (status !== 200) { console.error(`HTTP ${status}: ${JSON.stringify(data)}`); process.exit(1); }
    if (jsonOut) { emit(data); break; }
    const rows = Array.isArray(data) ? data : data.models || [];
    console.log(`zen models — ${base}  (${new Date().toISOString()})`);
    for (const m of rows) {
      const at = m.next_check_at ? new Date(m.next_check_at).toISOString().slice(11, 16) : '—';
      console.log(`${String(m.model).padEnd(34)} ${String(m.status || '').padEnd(8)} ${String(m.verdict || '').padEnd(5)} next ${at}  ${m.last_error || ''}`);
    }
    if (!rows.length) console.log('(empty — the table learns only from reports)');
    break;
  }
  case 'metrics': {
    const { status, data } = await call('/zen/pool/metrics');
    if (status !== 200) { console.error(`HTTP ${status}: ${JSON.stringify(data)}`); process.exit(1); }
    emit(data);
    break;
  }
  case 'scale': {
    const { status, data } = await call('/zen/pool/scale', { method: 'POST', body: rest[0] ? { demand: Number(rest[0]) } : {} });
    if (status !== 200) { console.error(`HTTP ${status}: ${JSON.stringify(data)}`); process.exit(1); }
    emit(data);
    break;
  }
  case 'result': {
    const taskId = rest[0];
    if (!taskId) { console.error('usage: zen-pool-client.mjs result <task_id>'); process.exit(2); }
    const { status, data } = await call(`/zen/pool/result/${encodeURIComponent(taskId)}`);
    if (status !== 200) { console.error(`HTTP ${status}: ${JSON.stringify(data)}`); process.exit(1); }
    emit(data);
    break;
  }
  case 'call': {
    const model = rest[0];
    if (!model) { console.error('usage: zen-pool-client.mjs call <model> [prompt] | --messages @file.json'); process.exit(2); }
    if (!token) { console.error('no token: set $ZEN_RUNNER_TOKEN or ~/.llm-ladder-zen-token'); process.exit(2); }
    const messagesFile = flag('messages');
    const body = { model, wait_ms: Number(flag('wait-ms', 0)) || undefined, max_tokens: Number(flag('max-tokens', 0)) || undefined };
    if (messagesFile) {
      const raw = readFileSync(messagesFile.replace(/^@/, ''), 'utf8');
      body.messages = JSON.parse(raw);
      if (!Array.isArray(body.messages) || !body.messages.length) { console.error('messages must be a non-empty array'); process.exit(2); }
    } else {
      const prompt = rest.slice(1).join(' ') || flag('prompt') || '';
      if (!prompt.trim()) { console.error('prompt is required (or --messages @file.json)'); process.exit(2); }
      body.prompt = prompt;
    }

    const startedAt = Date.now();
    let { status, data } = await call('/zen/pool/invoke', { method: 'POST', body });

    if (status === 504 && data.task_id) {
      const pollMs = Number(flag('poll-ms', 120_000));
      const deadline = Date.now() + pollMs;
      if (!jsonOut) console.error(`watchdog fired at ${data.wait_ms}ms (task ${data.task_id}) — polling the answer…`);
      for (;;) {
        await new Promise(r => setTimeout(r, 2000));
        ({ status, data } = await call(`/zen/pool/result/${encodeURIComponent(data.task_id)}`));
        if (data.state === 'done' || data.state === 'failed') { status = data.state === 'done' ? 200 : 502; break; }
        if (Date.now() >= deadline) { console.error(`still ${data.state} after ${pollMs}ms — task ${data.task_id}`); process.exit(1); }
      }
    }

    if (status !== 200) {
      console.error(`HTTP ${status}: ${JSON.stringify(data)}`);
      process.exit(1);
    }
    const wall = Date.now() - startedAt;
    if (jsonOut) { emit(data); break; }
    if (data.cold_start) console.error(`cold start: +${data.cold_start.boot_ms ?? '?'}ms boot (${(data.cold_start.dispatched || []).join(', ')})`);
    console.log(`${model} — ${wall}ms wall, provider ${data.provider_ms ?? '?'}ms, worker ${data.worker_id || '—'}`);
    if (data.ok === false) { console.error(`failed: kind=${data.kind || '—'} ${data.error || ''}`); process.exit(1); }
    console.log('');
    console.log(data.text || '');
    break;
  }
  default:
    console.error(`usage: zen-pool-client.mjs <health|pool|models|metrics|scale|call|result> [args]` +
      `\n  call: node scripts/zen-pool-client.mjs call <model> "2+4?" [--wait-ms N] [--max-tokens N] [--json]` +
      `\n  call: node scripts/zen-pool-client.mjs call <model> --messages @turns.json [--poll-ms N]`);
    process.exit(2);
}