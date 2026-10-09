import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const recoveredTokenFile = fileURLToPath(new URL('../.local/ladder/token', import.meta.url));

export function getLadderCredential({ env = process.env, directory = homedir(), read = readFileSync } = {}) {
  for (const name of ['LADDER_TOKEN', 'LLM_LADDER_TOKEN']) {
    const token = String(env[name] || '').trim();
    if (token) return { token, source: name };
  }
  for (const file of [join(directory, 'agent-tokens/llm-ladder/token'), join(directory, '.llm-ladder-token'), recoveredTokenFile]) {
    try {
      const token = read(file, 'utf8').trim();
      if (token) return { token, source: file };
    } catch { /* Missing local credentials can fall back to the legacy file. */ }
  }
  return null;
}

export function readLadderToken(options) {
  return getLadderCredential(options)?.token || null;
}
