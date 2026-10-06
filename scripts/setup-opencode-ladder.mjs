#!/usr/bin/env node
// One-command opencode → llm-ladder setup for a FRESH machine. Self-contained: no repo, no
// dependencies, nothing imported from this project — it is meant to be fetched and run anywhere.
//
//   node setup-opencode-ladder.mjs --token=<LADDER_TOKEN>
//   LADDER_TOKEN=<...> node setup-opencode-ladder.mjs
//
// What it does, in order:
//   1. writes ~/agent-tokens/llm-ladder/token      (chmod 600) — what opencode reads
//   2. merges provider.ladder into ~/.config/opencode/opencode.json
//      (creates the file if absent; .bak-pre-setup if it edits an existing one)
//   3. fills provider.ladder.models from the ladder's own /v1/models — the list is NOT hand
//      maintained, opencode refuses undeclared ids (ProviderModelNotFoundError)
//   4. proves it works with one live call
//
// Flags:  --dry-run   show what would change, write nothing
//         --base=URL  ladder base (default https://llm-ladder.trainedassist.store)
//         --models=N  default model to set on a freshly created config (default ladder/build)
//
// Re-running is safe: it is idempotent and always takes the model list from the ladder.
import fs from 'node:fs';
import readline from 'node:readline';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const has = (k) => argv.some((a) => a === `--${k}` || a.startsWith(`--${k}=`));
const val = (k, d) => {
  const a = argv.find((x) => x.startsWith(`--${k}=`));
  return a ? a.slice(k.length + 3) : d;
};

const HOME = os.homedir();
const CONFIG = path.join(HOME, '.config/opencode/opencode.json');
const TOKEN_FILE = path.join(HOME, 'agent-tokens/llm-ladder/token');
const BASE = (val('base', process.env.LADDER_BASE || 'https://llm-ladder.trainedassist.store')).replace(/\/+$/, '');
const DRY = has('dry-run');
const PROVIDER = 'ladder';

const ok = (m) => console.log(`  ok   ${m}`);
const info = (m) => console.log(`  ...  ${m}`);
const fail = (m) => { console.error(`\nSETUP FAIL: ${m}`); process.exit(1); };

// ---------------------------------------------------------------- token
function tokenFromDisk(p) { try { return fs.readFileSync(p, 'utf8').trim(); } catch { return null; } }

function promptHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // Hide the echo: a token typed on someone else's screen should not end up on the screen.
    const out = process.stdout.write.bind(process.stdout);
    rl._writeToOutput = (s) => { if (s.includes('\n')) out('\n'); };
    out(question);
    rl.question('', (answer) => { rl.close(); resolve(String(answer).trim()); });
  });
}

let token = (argv.find((a) => a.startsWith('--token=')) || '').slice('--token='.length)
  || (process.env.LADDER_TOKEN || '').trim()
  || tokenFromDisk(TOKEN_FILE)
  || tokenFromDisk(path.join(HOME, '.llm-ladder-token'));

if (!token) {
  if (process.stdin.isTTY && !argv.includes('--no-prompt')) {
    // Never keep a token in argv/shell history: it is visible in `ps`.
    token = await promptHidden('LADDER_TOKEN (ввод не виден на экране): ');
    if (!token) fail('empty token');
  } else {
    fail(`no token. One of:
  LADDER_TOKEN=<...> node setup-opencode-ladder.mjs     (token via env, not argv)
  node setup-opencode-ladder.mjs                        (interactive prompt — needs a terminal)
  The value is the ladder's Bearer token: it lives in the ladder worker secret LADDER_TOKEN and
  in ~/.llm-ladder-token on your own machine. Never commit it or paste it into a repo.`);
  }
}

// ---------------------------------------------------------------- model list from the ladder
async function fetchModels() {
  const res = await fetch(`${BASE}/v1/models`, { headers: { authorization: `Bearer ${token}` } });
  if (res.status === 401) fail(`the token was rejected by ${BASE} (401) — check --token`);
  if (!res.ok) fail(`/v1/models answered ${res.status} from ${BASE}`);
  const ids = (await res.json()).data.map((m) => m.id).filter(Boolean);
  if (!ids.length) fail('/v1/models returned no models');
  return ids;
}

console.log(`ladder: ${BASE}`);
let ids;
try { ids = await fetchModels(); } catch (e) { fail(`cannot reach ${BASE}: ${e.message}`); }
ok(`${ids.length} models advertised by /v1/models`);

// ---------------------------------------------------------------- proof — BEFORE writing anything
// `ladder/build` is opencode's provider-prefixed id; the ladder itself only knows `build`. Proving
// the round trip first means a bad token or an unreachable ladder leaves no half-written config.
const stripProvider = (m) => String(m).replace(new RegExp(`^${PROVIDER}/`), '');
const wantDefault = stripProvider(val('models', 'ladder/build'));
const proofId = ids.includes(wantDefault) ? wantDefault : ids[0];
info(`verifying with one live call (model "${proofId}") …`);
try {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: proofId, messages: [{ role: 'user', content: 'Reply with exactly one word: OK' }], max_tokens: 20 }),
  });
  if (!res.ok) fail(`verification call answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  ok(`ladder answered from "${j.model}" — token, baseURL and ladder are all correct`);
} catch (e) { fail(`verification call failed: ${e.message}`); }

// ---------------------------------------------------------------- token file
if (DRY) {
  info(`would write ${TOKEN_FILE} (mode 600)`);
} else {
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
  fs.chmodSync(TOKEN_FILE, 0o600);
  ok(`token file: ${TOKEN_FILE} (0600)`);
}

// ---------------------------------------------------------------- config
let cfg = {};
let created = false;
if (fs.existsSync(CONFIG)) {
  try { cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8')); }
  catch (e) { fail(`${CONFIG} is not valid JSON (${e.message}). Fix it, or move it aside and re-run.`); }
} else {
  created = true;
  cfg = { $schema: 'https://opencode.ai/config.json' };
}

const before = cfg.provider?.[PROVIDER] || null;
const beforeIds = new Set(Object.keys(before?.models || {}));

// Preserve hand-written extras (aliases are not in /v1/models) — only ids that are already there.
const keep = Object.keys(before?.models || {}).filter((m) => !ids.includes(m));
const models = {};
for (const id of [...ids, ...keep]) models[id] = before?.models?.[id] || { name: `ladder ${id}` };

const options = { ...(before?.options || {}) };
options.baseURL = options.baseURL || `${BASE}/v1`;
if (!options.apiKey) options.apiKey = '{file:~/agent-tokens/llm-ladder/token}';

cfg.provider = cfg.provider || {};
cfg.provider[PROVIDER] = { ...(before || {}), npm: '@ai-sdk/openai-compatible', name: 'Ladder', options, models };
if (created) cfg.model = cfg.model || val('models', 'ladder/build');

const added = Object.keys(models).filter((m) => !beforeIds.has(m));
const removed = [...beforeIds].filter((m) => !(m in models));
info(`provider.ladder.models: +${added.length} −${removed.length}${created ? ' (new config)' : ''}`);
if (keep.length) ok(`kept ${keep.length} non-advertised id(s): ${keep.join(', ')}`);

if (DRY) { console.log('\ndry run — nothing written'); process.exit(0); }

if (!created) fs.copyFileSync(CONFIG, `${CONFIG}.bak-pre-setup`);
fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n');
ok(`${created ? 'created' : 'updated'}: ${CONFIG}${created ? '' : ' (backup .bak-pre-setup)'}`);

console.log(`
Done. Now:
  1. quit opencode if it is running (config is read once at startup);
  2. start it and pick a model — "ladder build" is the default;
  3. profiles are optional: pick one in ${path.dirname(CONFIG)}/profiles/ or set "model" yourself.

Re-run this any time after the ladder changes its model list — it only refreshes
provider.ladder.models and never touches the rest of your config.`);
