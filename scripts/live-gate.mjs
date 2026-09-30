#!/usr/bin/env node
// Live gate — the checks an agent (or a human) runs against the RUNNING worker: prod by default,
// a local `npm run dev` via LADDER_BASE=http://localhost:8787.
//
// What it proves, in order:
//   1. GET  /health             the worker is up and reports a build id
//   2. POST /v1/chat/completions one pinned call (ladder_rung, no failover) per rung of the gate
//      ladder answers HTTP 200 and that exact rung served it (body.model)
//   3. GET  /v1/state           none of those rungs is parked in skip
//
// Config: LADDER (default deepseek), LADDER_ROLE (default build), LADDER_GATE_RUNGS (space
// separated rung ids) to pin an explicit set instead of the whole ladder.
// Token: $LADDER_TOKEN, else ~/.llm-ladder-token (chmod 600) — the value is never printed.
// Exit: 0 green, 1 a check failed, 2 no token / unknown ladder.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = (process.env.LADDER_BASE || 'https://llm-ladder.trainedassist.store').replace(/\/+$/, '');
const LADDER = process.env.LADDER || 'deepseek';
const ROLE = process.env.LADDER_ROLE || 'build';

function readToken() {
  if (process.env.LADDER_TOKEN && process.env.LADDER_TOKEN.trim()) return process.env.LADDER_TOKEN.trim();
  try { return fs.readFileSync(path.join(os.homedir(), '.llm-ladder-token'), 'utf8').trim(); }
  catch { return null; }
}
const token = readToken();
if (!token) {
  console.error('GATE SKIP: no token — export LADDER_TOKEN or create ~/.llm-ladder-token (chmod 600).');
  process.exit(2);
}

const config = JSON.parse(fs.readFileSync(new URL('../config/ladders.json', import.meta.url)));
const rungs = process.env.LADDER_GATE_RUNGS
  ? process.env.LADDER_GATE_RUNGS.trim().split(/\s+/)
  : config.ladders[LADDER]?.[ROLE];
if (!rungs || !rungs.length) {
  console.error(`GATE SKIP: no rungs for ${LADDER}:${ROLE} and no LADDER_GATE_RUNGS`);
  process.exit(2);
}

const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
let failed = 0;
function report(name, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

// 1. liveness
try {
  const h = await (await fetch(`${BASE}/health`)).json();
  report('/health', h.ok === true, h.build ? `build ${String(h.build).slice(0, 7)}` : JSON.stringify(h));
} catch (e) {
  report('/health', false, `unreachable: ${e.message}`);
}

// 2. one pinned call per gate rung — no failover, so a 200 means THIS rung answered
for (const rung of rungs) {
  let ok = false, detail = '';
  try {
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ model: LADDER, ladder_rung: rung, messages: [{ role: 'user', content: 'gate' }] }),
    });
    const data = await res.json().catch(() => null);
    ok = res.status === 200 && data?.model === rung;
    detail = res.status === 200 ? `answered=${data?.model}` : `HTTP ${res.status} ${data?.error?.message || ''}`;
  } catch (e) {
    detail = `unreachable: ${e.message}`;
  }
  report(`pin ${rung}`, ok, detail);
}

// 3. nothing in the gate set parked in skip
try {
  const res = await fetch(`${BASE}/v1/state`, { headers: auth });
  const st = await res.json().catch(() => null);
  if (res.status !== 200 || !st?.health) {
    report('/v1/state', false, `HTTP ${res.status} ${st?.error?.message || JSON.stringify(st)}`);
  } else {
    const now = Date.now();
    for (const rung of rungs) {
      const until = st.health[rung]?.skipUntil || 0;
      const inSkip = until > now;
      report(`state ${rung}`, !inSkip, inSkip ? `skipped for ${Math.round((until - now) / 1000)}s` : 'not in skip');
    }
  }
} catch (e) {
  report('/v1/state', false, `unreachable: ${e.message}`);
}

console.log(failed ? `GATE FAIL: ${failed} check(s) red (${BASE})` : `GATE PASS: ${rungs.length} rung(s) green (${BASE})`);
process.exit(failed ? 1 : 0);
