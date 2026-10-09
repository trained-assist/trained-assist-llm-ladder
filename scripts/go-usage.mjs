#!/usr/bin/env node
import { readLadderToken } from './ladder-credentials.mjs';
// Remaining Go allowance per pool key, from the worker's GET /v1/go-usage (issue #91).
// The worker polls https://opencode.ai/zen/go/v1/usage per key and returns only index + percent
// (keys never leave the worker). Token from $LADDER_TOKEN or ~/.llm-ladder-token (chmod 600).
//
//   node scripts/go-usage.mjs            # against prod
//   LADDER_BASE=http://localhost:8787 node scripts/go-usage.mjs
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const base = (process.env.LADDER_BASE || 'https://llm-ladder.trainedassist.store').replace(/\/$/, '');
const token = readLadderToken();
if (!token) { console.error('no token: set $LADDER_TOKEN or ~/.llm-ladder-token'); process.exit(2); }

const res = await fetch(`${base}/v1/go-usage`, { headers: { Authorization: `Bearer ${token}` } });
if (!res.ok) { console.error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`); process.exit(1); }
const { keys } = await res.json();

const pct = (w) => (w && w.percent != null ? `${w.percent}%${w.status && w.status !== 'ok' ? ` (${w.status})` : ''}` : '—');
const reset = (w) => (w && w.resetsAt ? w.resetsAt.replace('T', ' ').replace(/\.\d+Z$/, 'Z') : '—');
console.log(`Go usage — ${base}  (${new Date().toISOString()})`);
console.log(`${'key'.padEnd(5)} ${'rolling'.padEnd(16)} ${'weekly'.padEnd(16)} ${'monthly'.padEnd(16)}`);
for (const k of keys) {
  if (k.error) { console.log(`${String(k.keyIndex).padEnd(5)} ERROR: ${k.error}`); continue; }
  console.log(`${String(k.keyIndex).padEnd(5)} ${pct(k.rolling).padEnd(16)} ${pct(k.weekly).padEnd(16)} ${pct(k.monthly).padEnd(16)}`);
}
console.log('');
for (const k of keys) {
  if (k.error) continue;
  console.log(`key ${k.keyIndex}: rolling resets ${reset(k.rolling)} | weekly ${reset(k.weekly)} | monthly ${reset(k.monthly)}`);
}
