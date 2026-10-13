import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

test('artifact cleanup deletes only ids selected by the zen-pool artifact filter', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-artifact-cleanup-'));
  const calls = path.join(tmp, 'calls');
  const fakeGh = path.join(tmp, 'gh');
  fs.writeFileSync(fakeGh, `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"--paginate repos/owner/worker/actions/artifacts"* ]]; then
  [[ "$*" == *'startswith("zen-pool-")'* ]]
  printf '101\\n202\\n'
elif [[ "$*" == *"--method DELETE repos/owner/worker/actions/artifacts/"* ]]; then
  printf '%s\\n' "$*" >> "$CALL_LOG"
else
  exit 9
fi
`);
  fs.chmodSync(fakeGh, 0o755);
  try {
    const output = execFileSync('bash', ['scripts/purge-zen-artifacts.sh', 'owner/worker'], {
      env: { ...process.env, PATH: `${tmp}:${process.env.PATH}`, CALL_LOG: calls, GH_TOKEN: 'test-token' },
      encoding: 'utf8',
    });
    assert.match(output, /removed 2 old zen-pool artifact/);
    const deleted = fs.readFileSync(calls, 'utf8').trim().split('\n');
    assert.deepEqual(deleted, [
      'api --method DELETE repos/owner/worker/actions/artifacts/101',
      'api --method DELETE repos/owner/worker/actions/artifacts/202',
    ]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
