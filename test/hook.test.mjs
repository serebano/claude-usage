import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const hook = new URL('../hooks/pause-guard.mjs', import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), 'cu-hook-'));
const run = (state) => {
  const f = join(dir, `s${Math.random()}.json`);
  if (state !== undefined) writeFileSync(f, typeof state === 'string' ? state : JSON.stringify(state));
  return spawnSync(process.execPath, [hook], { env: { ...process.env, CLAUDE_USAGE_STATE: f }, input: '{}', encoding: 'utf8' });
};
const future = new Date(Date.now() + 3600e3).toISOString();

test('allows when state missing, corrupt or ok', () => {
  assert.equal(run(undefined).status, 0);
  assert.equal(run('{not json').status, 0);
  assert.equal(run({ status: 'ok' }).status, 0);
});
test('blocks with exit 2 while paused before the reset', () => {
  const r = run({ status: 'paused', reason: 'session 96%', percent: 96, threshold: 95, resumes_at: future });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Usage limit 95% reached .* paused until .*resume/);
});
test('fails open when the reset time already passed', () => {
  assert.equal(run({ status: 'paused', resumes_at: new Date(Date.now() - 1000).toISOString() }).status, 0);
});
