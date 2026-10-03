#!/usr/bin/env node
// Client contract guard (issue #102).
//
// A ladder rename/removal is a BREAKING change for every client whose config still carries
// the old id: opencode provider profiles, agent ladder providers, anything with
// `ladder/<id>`. `npm test` cannot see those configs, so removing an alias passed CI and
// broke prod with `404 unknown ladder: deepseek:build`.
//
// This script closes that gap: it extracts every ladder model id the given client configs
// actually send, resolves each through the REAL resolver (config/ladders.json + aliases,
// same code path the worker uses), and exits non-zero listing the ones that do not resolve.
//
//   node scripts/check-client-contracts.mjs ~/.config/opencode/opencode.json \
//        <path-or-url-of-opencode.json> ...
//
// Pass `--fetch` once before the file list to read the rest over HTTPS (raw.githubusercontent).
// Configs you cannot reach (a VM) must be copied out first — e.g.
//   ssh gcp 'cat ~/.config/opencode/opencode.json' > /tmp/vm-opencode.json

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/ladders.json'), 'utf8'));

// Same resolution the worker does (src/ladder.js rungsFor): alias first, then role suffix.
function rungsFor(name) {
  const [rawLadder, role] = String(name).split(':');
  const ladder = (config.aliases && config.aliases[rawLadder]) || rawLadder;
  const l = config.ladders && config.ladders[ladder];
  if (!l) return null;
  return l[role || 'build'] || l.build || null;
}

// Every `ladder/<id>` anywhere in the config + the `models` keys of the ladder provider.
function idsFromOpencodeConfig(text) {
  const ids = new Set();
  for (const m of text.matchAll(/ladder\/([A-Za-z0-9_ -]+)["'`\s]/g)) ids.add(m[1].trim());
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* not pure json (jsonc) — regex only */ }
  const models = parsed && parsed.provider && parsed.provider.ladder && parsed.provider.ladder.models;
  if (models) for (const k of Object.keys(models)) ids.add(k);
  return ids;
}

// PROFILE_LADDER maps in the agent's opencode-ladder-provider.js: `name: 'ladder-id'`.
function idsFromAgentProvider(text) {
  const ids = new Set();
  const block = text.match(/PROFILE_LADDER\s*=\s*\{([\s\S]*?)\n\}/);
  if (block) for (const m of block[1].matchAll(/:\s*'([A-Za-z0-9_-]+)'/g)) ids.add(m[1]);
  const fb = text.match(/\|\|\s*'([A-Za-z0-9_-]+)'\s*;/);
  if (fb) ids.add(fb[1]);
  return ids;
}

async function load(spec, fetchRemote) {
  if (fetchRemote) {
    const res = await fetch(spec);
    if (!res.ok) throw new Error(`${spec} → HTTP ${res.status}`);
    return res.text();
  }
  return fs.readFileSync(spec, 'utf8');
}

const argv = process.argv.slice(2);
const fetchRemote = argv.includes('--fetch');
const specs = argv.filter(a => a !== '--fetch');

if (!specs.length) {
  console.error('usage: node scripts/check-client-contracts.mjs [--fetch] <config> [<config> …]');
  process.exit(2);
}

const all = new Map(); // id → Set(client labels)
for (const spec of specs) {
  let text;
  try { text = await load(spec, fetchRemote); } catch (e) { console.error(`skip ${spec}: ${e.message}`); continue; }
  const isAgentProvider = /PROFILE_LADDER/.test(text);
  const ids = isAgentProvider ? idsFromAgentProvider(text) : idsFromOpencodeConfig(text);
  for (const id of ids) {
    if (!all.has(id)) all.set(id, new Set());
    all.get(id).add(path.basename(spec));
  }
}

const broken = [];
for (const [id, clients] of [...all].sort((a, b) => a[0].localeCompare(b[0]))) {
  if (!rungsFor(id)) broken.push({ id, clients: [...clients].join(', ') });
}

console.log(`checked ${all.size} distinct ladder ids from ${specs.length} client config(s)`);
for (const [id, clients] of [...all].sort((a, b) => a[0].localeCompare(b[0]))) {
  const ok = rungsFor(id) ? 'ok  ' : 'FAIL';
  console.log(`  ${ok} ${id}  (${[...clients].join(', ')})`);
}

if (broken.length) {
  console.error(`\n${broken.length} client ladder id(s) DO NOT RESOLVE — a rename/removal will 404 them:`);
  for (const b of broken) console.error(`  ${b.id}  ← ${b.clients}`);
  process.exit(1);
}
console.log('\nall client ladder ids resolve.');
