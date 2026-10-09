#!/usr/bin/env node
import { readLadderToken } from './ladder-credentials.mjs';
// Speed digest for the ladder — a compact, readable answer to "what answered, how fast, and is
// anything slow". Reads the SAME data production already records (`GET /v1/analytics`, one row per
// served call in D1), so it costs no extra LLM calls: unlike `ladder-bench` it measures real
// traffic, not probes, and it can run as often as we like.
//
// Why it exists: `trained-assist-free-models-benchmark` already pins every rung and times it, but
// (a) it runs every 6 h, (b) it always ends red (`process.exit(ladderFail ? 1 : 0)`), so nobody
// reads it, and (c) its samples are its own probes. Speed of production traffic was therefore
// unobservable.
//
// Usage:
//   node scripts/speed-digest.mjs               # last 4 h, markdown to stdout
//   node scripts/speed-digest.mjs --hours=24
//   LADDER_BASE=http://localhost:8787 node scripts/speed-digest.mjs
//
// Exit: 0 always — a digest is information, not a gate. Slowness is marked ⚠️ inside the text.
// (Turning it into a red check is a one-line change to `SLOW_MS` once we agree on a budget.)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const hoursArg = argv.find((a) => a.startsWith('--hours='));
const HOURS = Number(hoursArg ? hoursArg.slice(8) : process.env.DIGEST_HOURS || 4);
const BASE = (process.env.LADDER_BASE || 'https://llm-ladder.trainedassist.store').replace(/\/+$/, '');

// A rung slower than this is marked. 15 s is deliberately generous: the free tiers are slow by
// design, the question is "did it get much worse", not "is it fast".
const SLOW_MS = Number(process.env.DIGEST_SLOW_MS || 15_000);
// A rung slower than this is called out as a problem, not a warning.
const BAD_MS = Number(process.env.DIGEST_BAD_MS || 45_000);

const readToken = readLadderToken;

const token = readToken();
if (!token) {
  console.error('no token: set $LLM_LADDER_TOKEN or create ~/.llm-ladder-token (chmod 600)');
  process.exit(2);
}

const res = await fetch(`${BASE}/v1/analytics?hours=${HOURS}`, { headers: { authorization: `Bearer ${token}` } });
if (!res.ok) { console.error(`/v1/analytics answered ${res.status}`); process.exit(2); }
const d = await res.json();

const secs = (ms) => (ms == null ? '—' : `${(ms / 1000).toFixed(1)} s`);
const num = (n) => String(n ?? 0);
const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : '—');

// models[] carries latency but not which ladder asked; rungs[] carries the ladder but not latency.
const latency = new Map((d.models || []).map((m) => [m.model, m]));

const t = d.totals || {};
const failed = t.failed || 0;
const calls = t.calls || 0;

const lines = [];
lines.push(`## ⏱ Ladder speed digest — ${HOURS}h`);
lines.push('');
lines.push(
  `**вызовов** ${num(calls)} · **отказов** ${num(failed)} (${pct(failed, calls)}) · `
  + `**стоимость** $${Number(t.cost_usd || 0).toFixed(6)}`
);
const sources = (d.sources || []).map((s) => `${s.source} ${s.pct}%`).join(' · ');
if (sources) lines.push(`**источники**: ${sources}`);
lines.push('');

// ---- rungs: which ladder, which model, how often, how fast -------------------------------
const rungs = [];
for (const l of d.ladders || []) for (const r of l.rungs || []) rungs.push({ ...r, failed: l.failed });
rungs.sort((a, b) => b.calls - a.calls);

if (rungs.length) {
  lines.push('### Ступени — что отвечало и за сколько');
  lines.push('');
  lines.push('| лестница | модель | вызовов | p50 | p95 |');
  lines.push('|---|---|---:|---:|---:|');
  for (const r of rungs.slice(0, 20)) {
    const m = latency.get(r.model) || {};
    const mark = m.ms_p50 == null ? '' : m.ms_p50 >= BAD_MS ? ' 🔴' : m.ms_p50 >= SLOW_MS ? ' ⚠️' : '';
    lines.push(`| ${r.ladder} | ${r.model} | ${num(r.calls)} | ${secs(m.ms_p50)}${mark} | ${secs(m.ms_p95)} |`);
  }
  lines.push('');
}

// ---- models by speed: the raw "how fast is this model" view ------------------------------
const fast = (d.models || []).filter((m) => m.ms_p50 != null).sort((a, b) => a.ms_p50 - b.ms_p50);
if (fast.length) {
  lines.push('### Скорость моделей (по p50)');
  lines.push('');
  lines.push('| модель | вызовов | p50 | p95 | с замером |');
  lines.push('|---|---:|---:|---:|---:|');
  for (const m of fast) {
    const mark = m.ms_p50 >= BAD_MS ? ' 🔴' : m.ms_p50 >= SLOW_MS ? ' ⚠️' : '';
    lines.push(`| ${m.model}${mark} | ${num(m.calls)} | ${secs(m.ms_p50)} | ${secs(m.ms_p95)} | ${num(m.with_usage)}/${num(m.calls)} |`);
  }
  lines.push('');
}

// ---- attention: what actually changed for the worse --------------------------------------
const warn = [];
for (const m of d.models || []) {
  if (m.ms_p50 == null) continue;
  if (m.ms_p50 >= BAD_MS) warn.push(`🔴 \`${m.model}\` — p50 ${secs(m.ms_p50)} (порог ${secs(BAD_MS)}), ${num(m.calls)} вызовов`);
  else if (m.ms_p50 >= SLOW_MS) warn.push(`⚠️ \`${m.model}\` — p50 ${secs(m.ms_p50)} (порог ${secs(SLOW_MS)}), ${num(m.calls)} вызовов`);
}
for (const l of d.ladders || []) {
  if (l.calls && l.failed / l.calls > 0.4) warn.push(`⚠️ лестница \`${l.ladder}\` — отказы ${pct(l.failed, l.calls)} (${num(l.failed)}/${num(l.calls)})`);
}
const topErr = (d.errors || [])[0];
if (topErr && topErr.calls >= Math.max(5, calls * 0.1)) {
  warn.push(`⚠️ топ-ошибка ×${num(topErr.calls)}: ${String(topErr.error).slice(0, 160)}`);
}
lines.push('### На что обратить внимание');
lines.push('');
if (warn.length) lines.push(...warn.map((w) => `- ${w}`));
else lines.push('- всё в пределах порогов');
lines.push('');
lines.push(`_пороги: ⚠️ ${secs(SLOW_MS)} · 🔴 ${secs(BAD_MS)} — настраиваются через DIGEST_SLOW_MS / DIGEST_BAD_MS_`);

console.log(lines.join('\n'));
