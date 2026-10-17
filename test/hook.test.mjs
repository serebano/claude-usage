import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const hook = new URL('../hooks/pause-guard.mjs', import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), 'cu-hook-'));
const write = (f, state) => writeFileSync(f, typeof state === 'string' ? state : JSON.stringify(state));
const file = () => join(dir, `s${Math.random()}.json`);
const run = (state, env = {}) => {
  const f = file();
  if (state !== undefined) write(f, state);
  return spawnSync(process.execPath, [hook], { env: { ...process.env, CLAUDE_USAGE_STATE: f, ...env }, input: '{}', encoding: 'utf8', timeout: 10e3 });
};
const future = new Date(Date.now() + 3600e3).toISOString();

test('allows when state missing, corrupt or ok', () => {
  assert.equal(run(undefined).status, 0);
  assert.equal(run('{not json').status, 0);
  assert.equal(run({ status: 'ok' }).status, 0);
});
test('wait mode holds the tool call until the monitor reports ok, then allows', async () => {
  const f = file();
  write(f, { status: 'paused', percent: 96, resumes_at: future });
  const { spawn } = await import('node:child_process');
  const started = Date.now();
  const child = spawn(process.execPath, [hook], { env: { ...process.env, CLAUDE_USAGE_STATE: f, CLAUDE_USAGE_GUARD_POLL_MS: '100' } });
  setTimeout(() => write(f, { status: 'ok' }), 600);
  const code = await new Promise((res) => child.on('exit', res));
  assert.equal(code, 0);
  assert.ok(Date.now() - started >= 500, 'held while paused');
});
test('block mode exits 2 with the reason while paused', () => {
  const r = run({ status: 'paused', reason: 'session 96%', percent: 96, threshold: 95, resumes_at: future }, { CLAUDE_USAGE_GUARD: 'block' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Usage limit 95% reached .* paused until /);
});
test('fails open when the reset time already passed', () => {
  assert.equal(run({ status: 'paused', resumes_at: new Date(Date.now() - 120e3).toISOString() }).status, 0);
});
