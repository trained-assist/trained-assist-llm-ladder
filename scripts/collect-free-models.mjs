#!/usr/bin/env node
import { readLadderToken } from './ladder-credentials.mjs';
// Free-model inventory collector (issue #111) — the cron entry point.
//
// The heavy lifting lives in the WORKER (src/free-models.js via POST /v1/free-models/collect):
// the Go catalog needs a pool key, and that key only exists in the worker secret
// OPENCODE_GO_API_KEYS — it never leaves the worker, is never logged, and this script never
// sees it. This script is the thin, retry-free caller: it posts one collection pass and
// prints the diff report (markdown to stdout, JSON with --json).
//
// Usage:
//   node scripts/collect-free-models.mjs [--base https://llm-ladder.trainedassist.store]
//                                       [--probe true|false] [--probe-limit N] [--probe-concurrency N]
//                                       [--dry-run] [--json] [--out file]
//
// Env: LLM_LADDER_TOKEN (or ~/.llm-ladder-token, chmod 600).
//
// Exit: 0 = collected (providers may still be degraded — see the report), 1 = the ladder
//       reported a failure, 2 = config error (no token / bad flags).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
function has(name) {
  return process.argv.includes(`--${name}`);
}
function flag(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return def === 'true';
  const v = process.argv[i + 1];
  return v === undefined ? true : /^(true|1|yes)$/i.test(v);
}

const cfg = {
  base: (arg('base', process.env.LADDER_BASE) || 'https://llm-ladder.trainedassist.store').replace(/\/$/, ''),
  probe: flag('probe', 'true'),
  probeLimit: Number(arg('probe-limit', '12')),
  probeConcurrency: Number(arg('probe-concurrency', '4')),
  dryRun: flag('dry-run', 'false'),
  json: has('json'),
  out: arg('out', ''),
};

for (const [k, v] of Object.entries({ probe_limit: cfg.probeLimit, probe_concurrency: cfg.probeConcurrency })) {
  if (!Number.isFinite(v)) { console.error(`--${k} must be a number`); process.exit(2); }
}

const token = readLadderToken;

const TOKEN = token();
if (!TOKEN) {
  console.error('no token: run node scripts/ladder-token.mjs to inspect credential sources');
  process.exit(2);
}

let res;
try {
  res = await fetch(`${cfg.base}/v1/free-models/collect`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      probe: cfg.probe,
      probe_limit: cfg.probeLimit,
      probe_concurrency: cfg.probeConcurrency,
      dry_run: cfg.dryRun,
    }),
    signal: AbortSignal.timeout(180_000),
  });
} catch (e) {
  console.error(`collect failed: ${e.message}`);
  process.exit(1);
}

const body = await res.json().catch(() => null);
if (!res.ok || !body) {
  console.error(`collect failed: HTTP ${res.status} ${JSON.stringify(body || {}).slice(0, 400)}`);
  process.exit(1);
}

const report = body.report || '';
if (cfg.json) {
  console.log(JSON.stringify(body, null, 2));
} else {
  console.log(report);
}
if (cfg.out) {
  fs.writeFileSync(cfg.out, `${report}\n`);
  console.error(`report: ${cfg.out}`);
}

// A degraded provider is a real signal in the Actions UI, but the report above is still the
// useful part of the run.
const failed = !!(body.by_provider && Object.values(body.by_provider).some((p) => !p.ok));
process.exit(failed ? 1 : 0);
