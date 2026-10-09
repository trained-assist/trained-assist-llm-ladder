import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const CONFIG = 'wrangler.hard-budget-sandbox.toml';
const ACCOUNT_ID = 'd740a05e9442c1d0feacae2dfc673e93';
const DB_ID = 'a717bc1d-fd70-400f-bace-9223de176ebe';
const DB_NAME = 'trained-assist-llm-ladder-hard-budget-sandbox';
const WORKER = 'trained-assist-llm-ladder-hard-budget-sandbox';
const PROVIDER_BASE = 'https://trained-assist-llm-ladder-budget-provider-mock.skillset-apply.workers.dev/v1';
const PROVIDER_SERVICE = 'trained-assist-llm-ladder-budget-provider-mock';

const gitStatus = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim();
if (gitStatus) {
  throw new Error('Refusing deployment from a dirty worktree; commit the exact sandbox source first.');
}
const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (process.env.BUILD_SHA && process.env.BUILD_SHA !== sourceSha) {
  throw new Error(`BUILD_SHA does not match clean source revision ${sourceSha}.`);
}

function wrangler(args) {
  return execFileSync('npx', ['--yes', 'wrangler@4', ...args], { encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'] });
}

const whoami = wrangler(['whoami']);
if (!whoami.includes(ACCOUNT_ID) || !whoami.includes('typeformowner@gmail.com')) {
  throw new Error('Cloudflare account guard failed; expected the trained-assist test account.');
}

const config = readFileSync(CONFIG, 'utf8');
if (!config.includes(`name = "${WORKER}"`) || !config.includes(`database_id = "${DB_ID}"`)
  || !config.includes(`database_name = "${DB_NAME}"`) || !config.includes('binding = "HARD_BUDGET_DB"')
  || !config.includes(`OPENROUTER_BASE_URL = "${PROVIDER_BASE}"`)
  || !config.includes(`service = "${PROVIDER_SERVICE}"`) || !config.includes('binding = "BUDGET_PROVIDER_MOCK"')
  || /^routes\s*=|custom_domain\s*=|pattern\s*=/m.test(config)) {
  throw new Error('Sandbox config target guard failed; refusing deployment.');
}

const databases = JSON.parse(wrangler(['d1', 'list', '--json']));
if (!databases.some((db) => db.name === DB_NAME && db.uuid === DB_ID)) {
  throw new Error('Expected isolated budget D1 database was not found in the active account.');
}

const deployed = wrangler(['deploy', '--config', CONFIG,
  '--var', `BUILD_SHA:${sourceSha}`,
  '--var', `OPENROUTER_BASE_URL:${PROVIDER_BASE}`]);
const endpoint = deployed.match(/https:\/\/[^\s]+\.workers\.dev/);
if (!endpoint) throw new Error('Deployment completed without a discoverable workers.dev endpoint.');

let health;
for (let attempt = 0; attempt < 8; attempt++) {
  try {
    const response = await fetch(`${endpoint[0]}/health`);
    if (response.ok) { health = await response.json(); break; }
  } catch { /* worker.dev route may need a short propagation window */ }
  await new Promise((resolve) => setTimeout(resolve, 3000));
}
if (!health?.ok || health.build !== sourceSha) {
  throw new Error(`Sandbox health/revision check failed: ${JSON.stringify(health || null)}`);
}
console.log(JSON.stringify({ worker: WORKER, endpoint: endpoint[0], build: health.build, account: ACCOUNT_ID, d1: DB_ID, routes: 'workers.dev only' }));
