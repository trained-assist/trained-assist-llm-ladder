#!/usr/bin/env node
// Zen free-tier limit probe — fires requests at https://opencode.ai/zen/v1 with the exact
// opencode-client fingerprint zen validates, catches the 429 FreeUsageLimitError, parses
// `retry-after`, and writes a JSON report. Built for issue #106 (runtime × limit research).
//
// The fingerprint (captured live via mitmproxy from opencode 1.18.31, see scripts/zen-relay.mjs):
//   authorization: Bearer public
//   user-agent:     opencode/1.18.31 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14
//   x-opencode-client: cli
//   x-opencode-project: global
//   x-opencode-request:  msg_<12 hex><12 alnum>
//   x-opencode-session:  ses_<12 hex><14 alnum>
//   stream: true   +   tools containing `shell` and `read` (zen 403s without them)
//
// Usage:
//   node scripts/zen-limit-probe.mjs [--url ...] [--model ...] [--requests N] [--concurrency N]
//                                   [--delay-ms N] [--spaced-ms N] [--max-tokens N]
//                                   [--omit field]... [--model-after M] [--header k:v]... [--out f]
//
// Modes:
//   default        fire --requests requests (--concurrency parallel, --delay-ms apart)
//   --spaced-ms N  fire one request every N ms until 429 — retry-after countdown vs wall
//                  clock reveals the window shape (fixed vs rolling)
//   --model-after  after the first 429, fire one request at that model — 429 there too
//                  means one shared bucket across free models, 200 means per-model
//   --omit         drop one fingerprint field per flag (ua|client|project|session|request|
//                  tools|stream|auth) — the mandatory-field matrix
//
// No dependencies (repo rule). Secrets: none — zen free tier is anonymous (Bearer public).
//
// This script MEASURES limits by firing unguarded requests. A job that only wants an answer
// should use scripts/zen-client.mjs instead (per-model rate window, daily budget, 429
// classification, cooldown) — see docs/free-tier-limits.md §"Calling zen free from a job".
import fs from 'node:fs';
import crypto from 'node:crypto';

const ZEN_URL = 'https://opencode.ai/zen/v1/chat/completions';
const UA = 'opencode/1.18.31 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14';
const SHELL_TOOL = { type: 'function', function: { name: 'shell', parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] } } };
const READ_TOOL = { type: 'function', function: { name: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } };

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
function has(name) {
  return process.argv.includes(`--${name}`);
}

const OMITTABLE = ['ua', 'client', 'project', 'session', 'request', 'tools', 'stream', 'auth'];
const omitted = new Set();
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] === '--omit' && i + 1 < process.argv.length) omitted.add(process.argv[i + 1]);
}
for (const o of omitted) if (!OMITTABLE.includes(o)) {
  console.error(`unknown --omit '${o}' (one of ${OMITTABLE.join('|')})`);
  process.exit(2);
}

const cfg = {
  url: arg('url', ZEN_URL),
  model: arg('model', 'mimo-v2.6-flash-free'),
  requests: Number(arg('requests', 50)),
  concurrency: Number(arg('concurrency', 1)),
  delayMs: Number(arg('delay-ms', 0)),
  spacedMs: Number(arg('spaced-ms', 0)),
  maxTokens: Number(arg('max-tokens', 8)),
  modelAfter: arg('model-after', ''),
  fillTokens: arg('fill-tokens', '').split(',').map(s => Number(s.trim())).filter(n => n > 0),
  out: arg('out', ''),
  headers: (() => {
    const out = [];
    for (let i = 0; i < process.argv.length; i++) {
      if (process.argv[i] === '--header' && i + 1 < process.argv.length) {
        const h = process.argv[i + 1];
        const j = h.indexOf(':');
        out.push([h.slice(0, j).trim(), h.slice(j + 1).trim()]);
      }
    }
    return out;
  })(),
};

const randHex = n => crypto.randomBytes(n).toString('hex');
const randAlnum = n => {
  const c = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const b = crypto.randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += c[b[i] % c.length];
  return s;
};

function fingerprint() {
  const f = {
    authorization: 'Bearer public',
    'user-agent': UA,
    'x-opencode-client': 'cli',
    'x-opencode-project': 'global',
    'x-opencode-request': `msg_${randHex(6)}${randAlnum(12)}`,
    'x-opencode-session': `ses_${randHex(6)}${randAlnum(14)}`,
  };
  if (omitted.has('auth')) delete f.authorization;
  if (omitted.has('ua')) delete f['user-agent'];
  if (omitted.has('client')) delete f['x-opencode-client'];
  if (omitted.has('project')) delete f['x-opencode-project'];
  if (omitted.has('request')) delete f['x-opencode-request'];
  if (omitted.has('session')) delete f['x-opencode-session'];
  return f;
}

function body(model) {
  const b = {
    model,
    stream: !omitted.has('stream'),
    max_tokens: cfg.maxTokens,
    messages: [{ role: 'user', content: cfg.fillSize ? filler(cfg.fillSize) : arg('prompt', 'ping') }],
  };
  if (!omitted.has('tools')) {
    const t = arg('tools', 'shell,read');
    if (t !== 'none') b.tools = t.split(',').map(n => n === 'shell' ? SHELL_TOOL : READ_TOOL);
  }
  return b;
}

// Context probe: build a prompt of ~N tokens by repeating a sentence. The exact count is
// reported back from usage.prompt_tokens on a 200; on a 400 the server usually names the cap.
// ~4.2 chars/token for this ASCII sentence (calibrated against usage.prompt_tokens).
function filler(tokens) {
  const phrase = 'The quick brown fox jumps over the lazy dog. ';
  const reps = Math.ceil((tokens * 4.2) / phrase.length);
  return phrase.repeat(reps);
}

function classify(status, text) {
  if (status === 429) return 'FreeUsageLimitError';
  try {
    const j = JSON.parse(text);
    return j?.error?.type || `HTTP${status}`;
  } catch { return `HTTP${status}`; }
}

async function fire(model) {
  const headers = { 'content-type': 'application/json', ...fingerprint() };
  for (const [k, v] of cfg.headers) headers[k] = v;
  const started = Date.now();
  let res, text = '';
  try {
    res = await fetch(cfg.url, { method: 'POST', headers, body: JSON.stringify(body(model)) });
    text = await res.text();
  } catch (e) {
    return { status: 0, retryAfterSec: null, ms: Date.now() - started, errorType: `fetch:${e.message}`, bodySnippet: '', usage: null };
  }
  let usage = null;
  if (res.status === 200) {
    const m = text.match(/"usage":\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/);
    if (m) { try { usage = JSON.parse(m[0].slice(8)); } catch { /* keep null */ } }
  }
  return {
    status: res.status,
    retryAfterSec: res.headers.get('retry-after'),
    ms: Date.now() - started,
    errorType: classify(res.status, text),
    bodySnippet: text.slice(0, 500),
    usage,
  };
}

const results = [];
let first429At = null;
const startedAt = new Date().toISOString();

async function one(i, model) {
  const r = await fire(model);
  results.push({ i, model, at: new Date().toISOString(), ...r });
  const tag = r.status === 200 ? 'ok' : r.status === 429 ? `429 retry-after=${r.retryAfterSec}` : `${r.status} ${r.errorType}`;
  console.log(`#${String(i).padStart(3)} ${r.ms}ms  ${tag}`);
  if (r.status === 429 && first429At === null) {
    first429At = i;
    if (cfg.modelAfter) {
      const probe = await fire(cfg.modelAfter);
      results.push({ i: `${i}+after`, model: cfg.modelAfter, at: new Date().toISOString(), ...probe });
      console.log(`  └─ model-after ${cfg.modelAfter}: ${probe.status === 200 ? '200 (per-model bucket)' : probe.status === 429 ? `429 retry-after=${probe.retryAfterSec} (SHARED bucket)` : `${probe.status} ${probe.errorType}`}`);
    }
  }
  return r;
}

if (cfg.fillTokens.length) {
  // Context probe: one request per target size, no retry loop. Reports the ACTUAL prompt_tokens
  // the server counted (200) or the server's own error naming the cap (400/413).
  for (const size of cfg.fillTokens) {
    cfg.fillSize = size;
    const r = await fire(cfg.model);
    const pt = r.usage?.prompt_tokens;
    results.push({ i: `fill:${size}`, model: cfg.model, target: size, at: new Date().toISOString(), ...r });
    const tag = r.status === 200 ? `200  prompt_tokens=${pt}` : `${r.status} ${r.errorType}`;
    console.log(`fill target=${size} → ${tag} (${r.ms}ms)${r.status !== 200 ? '  ' + r.bodySnippet : ''}`);
  }
} else if (cfg.spacedMs > 0) {
  for (let i = 1; i <= cfg.requests; i++) {
    const r = await one(i, cfg.model);
    if (r.status === 429) break;
    if (i < cfg.requests) await new Promise(s => setTimeout(s, cfg.spacedMs));
  }
} else {
  const queue = Array.from({ length: cfg.requests }, (_, i) => i + 1);
  const workers = Array.from({ length: Math.min(cfg.concurrency, cfg.requests) }, async () => {
    for (;;) {
      const i = queue.shift();
      if (i === undefined) return;
      const r = await one(i, cfg.model);
      if (r.status === 429 && cfg.concurrency === 1) { queue.length = 0; return; }
      if (cfg.delayMs) await new Promise(s => setTimeout(s, cfg.delayMs));
    }
  });
  await Promise.all(workers);
}

const ok = results.filter(r => r.status === 200).length;
const limited = results.filter(r => r.status === 429);
const other = results.filter(r => r.status !== 200 && r.status !== 429);
const breakdown = {};
for (const r of other) breakdown[r.errorType] = (breakdown[r.errorType] || 0) + 1;

const report = {
  probe: 'zen-limit-probe',
  issue: '#106',
  startedAt,
  finishedAt: new Date().toISOString(),
  config: { ...cfg, omitted: [...omitted], fingerprint: fingerprint() },
  results,
  summary: {
    fired: results.length,
    ok,
    http429: limited.length,
    otherErrors: other.length,
    otherErrorBreakdown: breakdown,
    first429At,
    retryAfterSeries: limited.map(r => ({ i: r.i, at: r.at, retryAfterSec: r.retryAfterSec })),
    usageTotals: results.reduce((a, r) => {
      if (r.usage) {
        a.prompt += r.usage.prompt_tokens || 0;
        a.completion += r.usage.completion_tokens || 0;
        a.total += r.usage.total_tokens || 0;
        a.n++;
      }
      return a;
    }, { prompt: 0, completion: 0, total: 0, n: 0 }),
  },
};

const s = report.summary;
console.log(`\n--- ${s.ok} ok, ${s.http429} × 429, ${s.otherErrors} other ${JSON.stringify(s.otherErrorBreakdown)}`);
console.log(`first 429 at request #${s.first429At ?? 'never'}`);
if (s.retryAfterSeries.length) console.log('retry-after series:', s.retryAfterSeries.map(r => r.retryAfterSec).join(' → '));

if (cfg.out) {
  fs.writeFileSync(cfg.out, JSON.stringify(report, null, 2));
  console.log(`report: ${cfg.out}`);
}
