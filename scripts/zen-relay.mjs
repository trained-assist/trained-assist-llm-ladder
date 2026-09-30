#!/usr/bin/env node
// Zen free-tier relay — bridges the trained-assist-llm-ladder Worker to OpenCode Zen's free
// models (https://opencode.ai/zen/v1) from an IP that still has free quota (issue #36).
//
// Why a relay at all: Zen's free tier is double-gated — an exact opencode-client fingerprint
// (captured live via mitmproxy from opencode 1.18.31) AND IP reputation. Cloudflare Worker
// egress gets a stable 429 FreeUsageLimitError from every CF colo regardless of auth; this
// host (and residential IPs) get 200. The ladder worker therefore talks to THIS service
// (Bearer = shared relay token) and never touches zen directly.
//
// Protocol:
//   POST /chat/completions   OpenAI body, Authorization: Bearer <RELAY_TOKEN>
//                            (the ladder sends its OPENCODE_ZEN_RELAY_TOKEN as the provider key)
//   GET  /health             liveness
//
// What it does to every request before forwarding upstream:
//   * Authorization  → Bearer public        (zen free tier is anonymous; keys → 401)
//   * User-Agent     → opencode/1.18.31 ai-sdk/... runtime/bun/... (the captured fingerprint)
//   * x-opencode-client: cli, x-opencode-project: global
//   * x-opencode-request / x-opencode-session → msg_/ses_ in the exact shapes zen validates
//     (ses_<12 hex><14 alnum>; deterministic from the caller's x-session-id when present, so a
//      pinned conversation keeps its upstream prompt cache)
//   * tools          → shell + read merged in (zen 403s without those exact names);
//                      when the caller sent no tools at all, tool_choice: "none" so a service
//                      call never gets a stray shell tool_call back
//   * stream         → always true upstream (zen 403s on stream:false)
//
// Responses: caller wanted SSE → bytes are piped through untouched; caller wanted JSON → the
// upstream SSE is aggregated into one chat.completion. Upstream non-200 is forwarded verbatim
// so the ladder's error classifier sees zen's own words (e.g. "Rate limit exceeded" → quota).
//
// No dependencies (repo rule): node:http + node:crypto only. One JSON log line per request.

import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.env.PORT || 8789);
const RELAY_TOKEN = process.env.RELAY_TOKEN || '';
const ZEN_URL = process.env.ZEN_URL || 'https://opencode.ai/zen/v1/chat/completions';
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 90_000);
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const UA = 'opencode/1.18.31 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14';

const SHELL_TOOL = { type: 'function', function: { name: 'shell', parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] } } };
const READ_TOOL = { type: 'function', function: { name: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } };

if (!RELAY_TOKEN) {
  console.error('[zen-relay] RELAY_TOKEN is required — refusing to start unauthenticated');
  process.exit(1);
}

function tokenOk(header) {
  const provided = String(header || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(provided);
  const b = Buffer.from(RELAY_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const randHex = n => crypto.randomBytes(n).toString('hex');
const randAlnum = n => {
  const c = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const b = crypto.randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += c[b[i] % c.length];
  return s;
};

// ses_<12 hex><14 alnum> — the exact shape zen validated live; derived from the ladder's
// conversation id so a pinned conversation reuses one upstream session (prompt cache).
function sessionId(conversation) {
  if (conversation) {
    const h = crypto.createHash('sha256').update(String(conversation)).digest('hex');
    return `ses_${h.slice(0, 12)}${randAlnumId(h)}`;
  }
  return `ses_${randHex(6)}${randAlnum(14)}`;
}
function randAlnumId(hex) {
  const c = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 14; i++) s += c[parseInt(hex.slice(12 + i, 13 + i), 16) % c.length];
  return s;
}

function mergeTools(body) {
  const callerTools = Array.isArray(body.tools) ? body.tools : null;
  const hasName = t => t && t.function && t.function.name;
  if (!callerTools) {
    body.tools = [SHELL_TOOL, READ_TOOL];
    if (!body.tool_choice) body.tool_choice = 'none';
    return;
  }
  const names = new Set(callerTools.filter(hasName).map(t => t.function.name));
  if (!names.has('shell')) body.tools.push(SHELL_TOOL);
  if (!names.has('read')) body.tools.push(READ_TOOL);
}

function json(res, status, obj) {
  const payload = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

// SSE → one chat.completion. Keeps content, tool_calls (merged by index), finish_reason, usage.
function aggregateSse(text) {
  let content = '';
  let finish = null;
  let usage = null;
  let id = null;
  let model = null;
  let created = null;
  const toolCalls = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let d;
    try { d = JSON.parse(payload); } catch { continue; }
    if (d.error) continue;
    if (d.id) id = d.id;
    if (d.model) model = d.model;
    if (d.created) created = d.created;
    if (d.usage) usage = d.usage;
    const choice = d.choices && d.choices[0];
    if (!choice) continue;
    const delta = choice.delta || {};
    if (typeof delta.content === 'string') content += delta.content;
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const i = tc.index || 0;
        toolCalls[i] = toolCalls[i] || { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (tc.id) toolCalls[i].id = tc.id;
        if (tc.function && tc.function.name) toolCalls[i].function.name += tc.function.name;
        if (tc.function && tc.function.arguments) toolCalls[i].function.arguments += tc.function.arguments;
      }
    }
    if (choice.finish_reason) finish = choice.finish_reason;
  }
  const message = { role: 'assistant', content };
  const tools = toolCalls.filter(Boolean);
  if (tools.length) message.tool_calls = tools;
  return {
    id: id || `zen-relay-${Date.now()}`,
    object: 'chat.completion',
    created: created || Math.floor(Date.now() / 1000),
    model: model || 'unknown',
    choices: [{ index: 0, message, finish_reason: finish || (tools.length ? 'tool_calls' : 'stop') }],
    ...(usage ? { usage } : {}),
  };
}

async function forward(req, res, body, startedAt) {
  const callerWantsStream = body.stream === true;
  body.stream = true;
  delete body.stream_options;
  body.stream_options = { include_usage: true };
  mergeTools(body);

  const conversation = req.headers['x-session-id'];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('upstream timeout')), UPSTREAM_TIMEOUT_MS);
  const drop = () => controller.abort(new Error('caller gone'));
  res.on('close', () => { if (!res.writableEnded) drop(); });

  let up;
  try {
    up = await fetch(ZEN_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer public',
        'user-agent': UA,
        'x-opencode-client': 'cli',
        'x-opencode-project': 'global',
        'x-opencode-request': `msg_${randHex(12)}${randAlnum(12)}`,
        'x-opencode-session': sessionId(conversation),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (!res.headersSent) json(res, 502, { error: { message: `zen upstream: ${e.message}` } });
    log(body.model, 502, startedAt, callerWantsStream, e.message);
    return;
  }
  clearTimeout(timer);

  if (!up.ok) {
    const text = await up.text().catch(() => '');
    if (!res.headersSent) {
      res.writeHead(up.status, { 'content-type': 'application/json' });
      res.end(text);
    }
    log(body.model, up.status, startedAt, callerWantsStream, text.slice(0, 160));
    return;
  }

  if (callerWantsStream) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const reader = up.body.getReader();
    const pump = async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) { res.end(); return; }
          res.write(Buffer.from(value));
        }
      } catch { res.end(); }
    };
    log(body.model, 200, startedAt, true, 'sse passthrough');
    pump();
    return;
  }

  const text = await up.text().catch(() => '');
  const aggregated = aggregateSse(text);
  log(body.model, 200, startedAt, false, `content=${String(aggregated.choices[0].message.content || '').length}B`);
  if (!res.headersSent) json(res, 200, aggregated);
}

function log(model, status, startedAt, stream, note) {
  console.log(JSON.stringify({ relay: 'zen', model, status, ms: Date.now() - startedAt, stream, note }));
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') return json(res, 200, { ok: true, relay: 'zen' });
  if (req.method !== 'POST' || req.url !== '/chat/completions') return json(res, 404, { error: { message: 'not found' } });
  if (!tokenOk(req.headers.authorization)) return json(res, 401, { error: { message: 'unauthorized' } });

  const startedAt = Date.now();
  let raw = '';
  let size = 0;
  let aborted = false;
  req.on('data', chunk => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) { aborted = true; json(res, 413, { error: { message: 'body too large' } }); req.destroy(); return; }
    raw += chunk;
  });
  req.on('end', () => {
    if (aborted) return;
    let body;
    try { body = JSON.parse(raw); } catch { return json(res, 400, { error: { message: 'bad json' } }); }
    if (!body || !Array.isArray(body.messages) || !body.messages.length) return json(res, 400, { error: { message: 'messages required' } });
    if (!body.model) return json(res, 400, { error: { message: 'model required' } });
    forward(req, res, body, startedAt).catch(e => {
      if (!res.headersSent) json(res, 500, { error: { message: `relay: ${e.message}` } });
      log(body.model, 500, startedAt, body.stream === true, e.message);
    });
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(JSON.stringify({ relay: 'zen', listening: `127.0.0.1:${PORT}`, upstream: ZEN_URL }));
});
