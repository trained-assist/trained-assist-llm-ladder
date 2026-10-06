#!/usr/bin/env node
// Sync the `provider.ladder.models` block in the local opencode config from the ladder's own
// /v1/models — so the model list never has to be maintained by hand again.
//
// Why this exists: opencode refuses any model id it has not been told about
// (`ProviderModelNotFoundError`), so the block is mandatory. Hand-maintaining it means it drifts
// from the ladder, and a stale id is a 404 the moment someone picks it (measured 2026-10-06:
// 9 dead ids, 8 ladders undeclared). The ladder is the source of truth; this copies it over.
//
// Usage:
//   npm run sync-opencode            # rewrite the block, print the diff
//   npm run sync-opencode -- --dry-run
//
// Config: OPENCODE_CONFIG_PATH (default ~/.config/opencode/opencode.json)
// Token:  $LADDER_TOKEN | $LLM_LADDER_TOKEN | ~/.llm-ladder-token | ~/agent-tokens/llm-ladder/token
// Base:   LADDER_BASE (default https://llm-ladder.trainedassist.store)
// Keep:   LADDER_KEEP=alias1,alias2 — extra model ids to preserve (aliases are not in /v1/models)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = os.homedir();
const CONFIG_PATH = process.env.OPENCODE_CONFIG_PATH || path.join(home, '.config/opencode/opencode.json');
const BASE = (process.env.LADDER_BASE || 'https://llm-ladder.trainedassist.store').replace(/\/+$/, '');
const PROVIDER = process.env.LADDER_PROVIDER || 'ladder';
const DRY = process.argv.includes('--dry-run');

function readToken() {
  const candidates = [
    process.env.LADDER_TOKEN,
    process.env.LLM_LADDER_TOKEN,
    readIf(path.join(home, '.llm-ladder-token')),
    readIf(path.join(home, 'agent-tokens/llm-ladder/token')),
  ];
  return candidates.map((v) => (v || '').trim()).find(Boolean) || null;
}
function readIf(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }

function die(msg) { console.error(`SYNC FAIL: ${msg}`); process.exit(1); }

const token = readToken();
if (!token) die('no token — set $LADDER_TOKEN or create ~/.llm-ladder-token (chmod 600)');

const res = await fetch(`${BASE}/v1/models`, { headers: { authorization: `Bearer ${token}` } });
if (!res.ok) die(`/v1/models answered ${res.status}`);
const data = await res.json();
const ids = (data.data || []).map((m) => m.id).filter(Boolean);
if (!ids.length) die('/v1/models returned no models');

let cfg;
try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
catch (e) { die(`cannot read ${CONFIG_PATH}: ${e.message}`); }

const provider = cfg.provider?.[PROVIDER];
if (!provider) die(`provider "${PROVIDER}" not found in ${CONFIG_PATH}`);

// Keep an existing display name (they are hand-worded, e.g. "= service"); new ids get the convention.
// /v1/models lists only canonical ladder names — aliases (config.aliases) and role fallbacks such as
// `free:plan` are resolvable but not advertised, so they would be pruned. LADDER_KEEP pins extras
// that are actually used, e.g. LADDER_KEEP=deepseek,free:plan.
const keep = new Set(String(process.env.LADDER_KEEP || '').split(',').map((s) => s.trim()).filter(Boolean));
const before = provider.models || {};
const after = {};
for (const id of [...ids, ...Object.keys(before).filter((k) => keep.has(k))]) {
  if (after[id]) continue;
  after[id] = before[id] ? { ...before[id] } : { name: `ladder ${id}` };
}

const removed = Object.keys(before).filter((k) => !(k in after));
const added = Object.keys(after).filter((k) => !(k in before));
const renamed = Object.keys(after).filter((k) => before[k] && JSON.stringify(before[k]) !== JSON.stringify(after[k]));

console.log(`ladder: ${ids.length} models from ${BASE}/v1/models`);
console.log(`  + added   (${added.length})${added.length ? ': ' + added.join(', ') : ''}`);
console.log(`  - removed (${removed.length})${removed.length ? ': ' + removed.join(', ') : ''}`);
console.log(`  ~ changed (${renamed.length})${renamed.length ? ': ' + renamed.join(', ') : ''}`);

if (!added.length && !removed.length && !renamed.length) {
  console.log('nothing to do — config already matches the ladder');
  process.exit(0);
}
if (DRY) { console.log('dry run — no file written'); process.exit(0); }

provider.models = after;
fs.copyFileSync(CONFIG_PATH, `${CONFIG_PATH}.bak-pre-sync`);
fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
console.log(`written: ${CONFIG_PATH} (backup: ${CONFIG_PATH}.bak-pre-sync)`);
console.log('restart opencode — the config is read once at startup.');
