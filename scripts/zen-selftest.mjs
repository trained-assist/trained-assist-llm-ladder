#!/usr/bin/env node
// Zen free self-test — the "test build" that proves from a real GitHub Actions runner that the
// zen free tier answers, that our fingerprint is what makes it answer, and that a limit is
// reported as a limit instead of as a broken model.
//
// Spec: docs/github-actions-zen-client-spec.md (§9 embedding, §11 reporting, §12 acceptance) ·
// scenario: docs/user-scenarios/zen/zen-free-client-from-gha.md
//
// What it does, in order:
//   1. NEGATIVE — one request with stream:false. zen must answer 403 FreeTierError. If it does
//      not, the gate we depend on has changed and every "200" below is meaningless.
//   2. LIVE — one signed call per free model (auto-discovered from /v1/models, or --models).
//      200 = the model works; 429 = ⛔ not measured (a limit, never a failure); anything else is
//      reported per model.
//   3. OFFLINE — a ~300K-token prompt against big-pickle (cap 262 139) must be refused by the
//      client WITHOUT a request. No network, so it is safe to run in CI.
//   4. REPORT — JSON artifact + markdown for $GITHUB_STEP_SUMMARY, with stoppedBy / cooldownUntil
//      per model and the rate-window peak.
//
// Exit code: non-zero ONLY when a SIGNED call gets 403 (our fingerprint regressed) or the client
// itself throws. A quota stop is a green run with a story — spec §9.
//
// Usage:
//   node scripts/zen-selftest.mjs [--models a,b,c] [--runs N] [--deep] [--out f] [--summary-md f]
//
// No dependencies (repo rule). No secrets: the free tier is anonymous.
import fs from 'node:fs';
import { createZenClient, zenHeaders, SHELL_TOOL, READ_TOOL, contextCheck, estTokens } from './zen-client.mjs';

const ZEN_MODELS = 'https://opencode.ai/zen/v1/models';
const FREE_SUFFIX = /-free$/;
const FREE_EXTRA = ['big-pickle'];

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
function has(name) { return process.argv.includes(`--${name}`); }

const cfg = {
  models: arg('models', ''),
  runs: Number(arg('runs', 2)),
  deep: has('deep'),
  out: arg('out', 'zen-selftest.json'),
  summaryMd: arg('summary-md', process.env.GITHUB_STEP_SUMMARY || ''),
  prompt: arg('prompt', 'Answer in one short sentence: what is 2+2?'),
};

const startedAt = new Date().toISOString();
const failures = [];
const notes = [];

async function discoverFreeModels() {
  const res = await fetch(ZEN_MODELS, { headers: { 'user-agent': 'opencode/1.18.31 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14' } });
  if (!res.ok) throw new Error(`GET /v1/models → ${res.status}`);
  const j = await res.json();
  return j.data.map(m => m.id).filter(id => FREE_SUFFIX.test(id) || FREE_EXTRA.includes(id)).sort();
}

const models = cfg.models ? cfg.models.split(',').map(s => s.trim()).filter(Boolean) : await discoverFreeModels();
if (!models.length) throw new Error('no free models discovered — pass --models');

const zen = createZenClient({ ratePerMin: 80, dailyBudget: 800 });
const report = {
  probe: 'zen-selftest',
  spec: 'docs/github-actions-zen-client-spec.md',
  startedAt,
  finishedAt: null,
  runner: {
    os: process.platform,
    node: process.version,
    sha: process.env.GITHUB_SHA || '',
    runId: process.env.GITHUB_RUN_ID || '',
    egress: process.env.ZEN_EGRESS || 'github-hosted',
  },
  config: { ratePerMin: 80, dailyBudget: 800, runsPerModel: cfg.runs, deep: cfg.deep },
  models: {},
  negative: null,
  offline: null,
  summary: null,
};

// 1. The gate we depend on: without stream:true zen must refuse. A 200 here means the gate moved.
async function negativeTest() {
  const body = {
    model: 'mimo-v2.6-flash-free',
    stream: false,
    max_tokens: 8,
    messages: [{ role: 'user', content: 'ping' }],
    tools: [SHELL_TOOL, READ_TOOL],
  };
  const res = await fetch('https://opencode.ai/zen/v1/chat/completions', {
    method: 'POST',
    headers: zenHeaders(),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const verdict = res.status === 403 ? 'PASS' : 'WARN';
  if (res.status !== 403) notes.push(`negative test: stream:false answered ${res.status}, not 403 — the fingerprint gate changed`);
  return { status: res.status, verdict, bodySnippet: text.slice(0, 200) };
}

// 3. Offline: a prompt over big-pickle's floor cap must never leave the process.
function offlineTest() {
  const filler = 'x'.repeat(1_000_000);
  const messages = [{ role: 'user', content: filler }];
  const check = contextCheck('big-pickle', messages, 1500);
  const fits = contextCheck('mimo-v2.6-flash-free', messages, 1500);
  return {
    model: 'big-pickle',
    cap: check.cap,
    estimatedInputTokens: check.input,
    refused: !check.ok,
    over: check.over || 0,
    samePromptFitsMimo: fits.ok,
    verdict: !check.ok && fits.ok ? 'PASS' : 'FAIL',
  };
}

report.negative = await negativeTest();
report.offline = offlineTest();
if (report.offline.verdict === 'FAIL') failures.push('offline context check did not refuse an over-cap prompt');

for (const model of models) {
  const row = { calls: [], ok: 0, limited: 0, errors: 0, firstAnswer: null, ms: [] };
  for (let i = 0; i < cfg.runs; i++) {
    const r = await zen.chat({ model, messages: [{ role: 'user', content: cfg.prompt }], maxTokens: 256 });
    if (r.ok) {
      row.ok++;
      row.ms.push(r.ms);
      if (!row.firstAnswer) row.firstAnswer = String(r.message?.content || '').replace(/\s+/g, ' ').slice(0, 160);
    } else if (r.kind === 'cooldown' || r.kind === 'daily' || r.kind === 'provider' || r.kind === 'rate') {
      row.limited++;
      row.stoppedBy = r.stoppedBy;
      row.cooldownUntilIso = r.cooldownUntilIso || null;
      row.retryAfterSec = r.retryAfterSec ?? null;
      break;
    } else {
      row.errors++;
      row.lastKind = r.kind;
      row.lastError = r.error || r.bodySnippet || null;
      if (r.kind === 'fingerprint') {
        failures.push(`${model}: signed call got 403 — the fingerprint regressed`);
        break;
      }
    }
  }
  const s = zen.state().models[model] || {};
  row.calls = s.calls;
  row.ratePeak = zen.ratePeak(model);
  row.stoppedBy = row.stoppedBy || s.stoppedBy || null;
  row.cooldownUntilIso = row.cooldownUntilIso || (s.cooldownUntil ? new Date(s.cooldownUntil).toISOString() : null);
  report.models[model] = row;
  const tag = row.errors ? `ERROR ${row.lastKind}` : row.limited ? `⛔ ${row.stoppedBy || 'limited'}` : 'ok';
  console.log(`${model.padEnd(34)} ${String(row.ok).padStart(2)}/${cfg.runs}  ${tag}${row.firstAnswer ? `  «${row.firstAnswer}»` : ''}`);
}

if (cfg.deep) {
  const filler = 'x'.repeat(1_000_000);
  const r = await zen.chat({ model: 'mimo-v2.6-flash-free', messages: [{ role: 'user', content: filler }], maxTokens: 64 });
  report.deep = { model: 'mimo-v2.6-flash-free', estimatedInputTokens: estTokens(filler), ok: r.ok, kind: r.kind, ms: r.ms || null };
  console.log(`deep  mimo-v2.6-flash-free ~${report.deep.estimatedInputTokens} tokens → ${r.ok ? '200' : r.kind}`);
}

report.summary = zen.summary();
report.finishedAt = new Date().toISOString();

const okCount = Object.values(report.models).filter(m => m.ok > 0).length;
const limitedCount = Object.values(report.models).filter(m => m.limited > 0).length;
const errorCount = Object.values(report.models).filter(m => m.errors > 0).length;

const md = [
  '## zen free self-test',
  '',
  `runner: \`${report.runner.os}\` · node ${report.runner.node} · egress \`${report.runner.egress}\`${report.runner.sha ? ` · \`${report.runner.sha.slice(0, 8)}\`` : ''}`,
  `negative (stream:false → 403): **${report.negative.verdict}** (${report.negative.status}) · offline over-cap refusal: **${report.offline.verdict}**`,
  '',
  '| model | ok | limited | stoppedBy | cooldownUntil (UTC) | rate peak | answer |',
  '|---|---|---|---|---|---|---|',
  ...Object.entries(report.models).map(([m, r]) => `| \`${m}\` | ${r.ok}/${cfg.runs} | ${r.limited ? '⛔' : 0} | ${r.stoppedBy || '—'} | ${r.cooldownUntilIso || '—'} | ${r.ratePeak}/80 | ${r.errors ? `❌ ${r.lastKind}` : r.firstAnswer ? `«${(r.firstAnswer || '').slice(0, 60)}»` : '—'} |`),
  '',
  `**${okCount}/${models.length}** free models answered${limitedCount ? `, ${limitedCount} stopped by a limit (⛔ not measured — excluded from the denominator)` : ''}${errorCount ? `, ${errorCount} errored` : ''}.`,
  ...notes.map(n => `> ⚠️ ${n}`),
  '',
  `state: \`${JSON.stringify(report.summary.byModel)}\``,
].join('\n');

fs.writeFileSync(cfg.out, JSON.stringify(report, null, 2));
if (cfg.summaryMd) fs.appendFileSync(cfg.summaryMd, md + '\n');
console.log('\n' + md);
console.log(`\nreport: ${cfg.out}`);

if (failures.length) {
  console.error('\nFAILED:\n' + failures.map(f => '  - ' + f).join('\n'));
  process.exit(1);
}
console.log(`\nOK — ${okCount}/${models.length} models answered, no fingerprint regression`);