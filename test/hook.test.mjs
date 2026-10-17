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
const upd = new Date().toISOString();

test('allows when state missing, corrupt or ok', () => {
  assert.equal(run(undefined).status, 0);
  assert.equal(run('{not json').status, 0);
  assert.equal(run({ status: 'ok' }).status, 0);
});
test('wait mode holds the tool call until the monitor reports ok, then allows', async () => {
  const f = file();
  write(f, { status: 'paused', percent: 96, resumes_at: future, updated_at: upd });
  const { spawn } = await import('node:child_process');
  const started = Date.now();
  const child = spawn(process.execPath, [hook], { env: { ...process.env, CLAUDE_USAGE_STATE: f, CLAUDE_USAGE_GUARD_POLL_MS: '100' } });
  child.stdin.end('{}');
  setTimeout(() => write(f, { status: 'ok' }), 600);
  const code = await new Promise((res) => child.on('exit', res));
  assert.equal(code, 0);
  assert.ok(Date.now() - started >= 500, 'held while paused');
});
test('block mode exits 2 with the reason while paused', () => {
  const r = run({ status: 'paused', reason: 'session 96%', percent: 96, threshold: 95, resumes_at: future, updated_at: upd }, { CLAUDE_USAGE_GUARD: 'block' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Usage limit 95% reached .* paused until /);
});
test('fails open when the reset time already passed', () => {
  assert.equal(run({ status: 'paused', resumes_at: new Date(Date.now() - 120e3).toISOString() }).status, 0);
});

const runTool = (state, tool) => {
  const f = file(); write(f, state);
  return spawnSync(process.execPath, [hook], { env: { ...process.env, CLAUDE_USAGE_STATE: f }, input: JSON.stringify({ tool_name: tool }), encoding: 'utf8', timeout: 10e3 });
};
test('warn (>= 80%) refuses new subagents but allows other tools', () => {
  const s = { status: 'ok', warn: true, percent: 86, updated_at: upd };
  const r = runTool(s, 'Agent');
  assert.equal(r.status, 2); assert.match(r.stderr, /86%.*subagents/);
  assert.equal(runTool(s, 'Bash').status, 0);
});
test('a stale paused state (monitor not updating) is not trusted', () => {
  const old = new Date(Date.now() - 30 * 60e3).toISOString();
  assert.equal(run({ status: 'paused', percent: 99, resumes_at: future, updated_at: old }).status, 0);
});
