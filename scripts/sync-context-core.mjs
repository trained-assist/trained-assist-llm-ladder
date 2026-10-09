// Generated runtime dependency; canonical source lives in context-chunks-mcp.
// Pin updates are deliberate. CI verifies the manifest without fetching unpinned code.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';

const repository = 'trained-assist/context-chunks-mcp';
const ref = '29c7664742f890afdfdad9ae61709984a06c1096';
const args = process.argv.slice(2), sourceIndex = args.indexOf('--source-dir');
const source = sourceIndex >= 0 ? args[sourceIndex + 1] : null;
const target = new URL('../vendor/context-chunks-mcp/', import.meta.url);
const files = {}, seen = new Set();
async function copy(path) {
  if (seen.has(path)) return;
  seen.add(path);
  let content;
  if (source) content = readFileSync(resolve(source, path), 'utf8');
  else {
    const response = await fetch(`https://raw.githubusercontent.com/${repository}/${ref}/${path}`);
    if (!response.ok) throw new Error(`Cannot fetch ${path}: ${response.status}`);
    content = await response.text();
  }
  const output = new URL(path, target);
  mkdirSync(dirname(output.pathname), { recursive: true }); writeFileSync(output, content);
  files[path] = createHash('sha256').update(content).digest('hex');
  for (const match of content.matchAll(/^[ \t]*(?:import|export)\b[^\r\n]*?\bfrom\s*(['"])([^'"\r\n]+)\1/gm)) {
    if (!match[2].startsWith('.')) throw new Error(`Nonportable import: ${match[2]}`);
    const dependency = resolve(dirname('/' + path), match[2]).slice(1);
    if (!dependency.startsWith('src/')) throw new Error(`Unexpected dependency: ${dependency}`);
    await copy(dependency);
  }
}
await copy('src/core.js');
writeFileSync(new URL('manifest.json', target), JSON.stringify({ repository, ref, files }, null, 2) + '\n');
console.log(`Pinned ${Object.keys(files).length} context core modules at ${ref}`);
