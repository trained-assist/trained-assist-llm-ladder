#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { getLadderCredential } from './ladder-credentials.mjs';

export async function tokenCommand(args, {
  credential = getLadderCredential(),
  base = process.env.LADDER_BASE || 'https://llm-ladder.trainedassist.store',
  fetchImpl = fetch, out = text => process.stdout.write(text), err = text => process.stderr.write(text),
  destination = join(homedir(), 'agent-tokens/llm-ladder/token'),
  save = (file, token) => { mkdirSync(dirname(file), { recursive: true, mode: 0o700 }); writeFileSync(file, token + '\n', { mode: 0o600 }); chmodSync(file, 0o600); },
} = {}) {
  if (args.length > 1 || args.some(a => !['--print', '--check', '--save', '--help'].includes(a))) {
    err('Usage: node scripts/ladder-token.mjs [--print | --check | --save | --help]\n'); return 2;
  }
  if (args[0] === '--help') {
    out('Default: show where the token was found.\n--print: print the token for local use or shell substitution.\n--check: verify it with GET /v1/models; no model call.\n--save: verify and save the found token to ~/agent-tokens/llm-ladder/token (0600), including a locally recovered token.\nSources: LADDER_TOKEN, LLM_LADDER_TOKEN, ~/agent-tokens/llm-ladder/token, ~/.llm-ladder-token, repository-local .local/ladder/token.\nA newly generated string only works after the server accepts it. Setup stores an existing issued token.\n'); return 0;
  }
  if (!credential) {
    err('No Ladder token found. Run node scripts/setup-opencode-ladder.mjs to store your issued token.\n'); return 2;
  }
  if (args[0] === '--print') { out(credential.token + '\n'); return 0; }
  if (!['--check', '--save'].includes(args[0])) { out('Ladder token found: ' + credential.source + '\nUse --check to verify access or --print to print it.\n'); return 0; }
  try {
    const response = await fetchImpl(base.replace(/\/+$/, '') + '/v1/models', {
      headers: { authorization: 'Bearer ' + credential.token }, signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) { err('Ladder access check failed: HTTP ' + response.status + ' (source: ' + credential.source + ').\n'); return 1; }
    const body = await response.json();
    if (!Array.isArray(body.data) || !body.data.length) { err('Ladder returned no model list.\n'); return 1; }
    if (args[0] === '--save') {
      try { save(destination, credential.token); }
      catch { err('Cannot save the token to ' + destination + '.\n'); return 1; }
      out('Ladder token verified and saved: ' + destination + ' (0600).\n'); return 0;
    }
    out('Ladder access OK: ' + body.data.length + ' models (source: ' + credential.source + ').\n'); return 0;
  } catch { err('Cannot reach Ladder API for the access check.\n'); return 1; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await tokenCommand(process.argv.slice(2));
}
