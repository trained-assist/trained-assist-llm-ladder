import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

// scripts/query-trace.py is the only read path into the D1 trace log; its guard must refuse writes.
// Loads the script as a module (its filename has a dash) and runs a snippet against it as `m`.
const LOAD = "import importlib.util as u; s = u.spec_from_file_location('qt', 'scripts/query-trace.py'); m = u.module_from_spec(s); s.loader.exec_module(m)";
const run = (code) => execFileSync('python3', ['-c', `${LOAD}\n${code}`], { encoding: 'utf8', stdio: 'pipe' });

test('query-trace: presets bind ids as params, not string-interpolated', () => {
  const out = run(`sql, p = m.build('user', "x' OR 1=1", 24, 50, None); print(sql); print(p[0])`);
  assert.match(out, /user_id = \?1/);
  assert.match(out, /x' OR 1=1/);
});

test('query-trace: sql preset allows only a single read-only SELECT', () => {
  assert.match(run(`print(m.guard('SELECT count(*) FROM ladder_calls;'))`), /SELECT count/);
  for (const bad of ['DELETE FROM ladder_calls', 'SELECT 1; DROP TABLE ladder_calls', 'WITH x AS (SELECT 1) DELETE FROM ladder_calls']) {
    assert.throws(() => run(`m.guard(${JSON.stringify(bad)})`));
  }
});
