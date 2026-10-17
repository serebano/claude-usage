import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  keychainServiceNames, parseUsage, formatLine, formatReset, formatResetIn, formatPretty, decide, decideUnknown, nextIntervalSec,
  fetchUsage, readCredentials, AuthError, NetworkError, normalizeDir,
} from '../lib/core.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/usage.json', import.meta.url)));
const HOME = '/home/example';

test('keychain service name: bare for ~/.claude, sha256 suffix otherwise', () => {
  const dir = '/home/example/.claude-0';
  const hex = createHash('sha256').update(dir).digest('hex').slice(0, 8);
  assert.deepEqual(keychainServiceNames(dir, HOME), [`Claude Code-credentials-${hex}`]);
  assert.equal(keychainServiceNames(join(HOME, '.claude'), HOME)[0], 'Claude Code-credentials');
  assert.match(keychainServiceNames(dir, HOME)[0], /^Claude Code-credentials-[0-9a-f]{8}$/);
});

test('normalizeDir expands ~ and strips trailing slash', () => {
  assert.equal(normalizeDir('~/.claude-1/', HOME), '/home/example/.claude-1');
});

test('parseUsage reads limits[] and labels scoped models', () => {
  const p = parseUsage(fixture);
  assert.deepEqual(p.limits.map((l) => [l.label, l.percent]), [['session', 28], ['week', 25], ['Fable', 7]]);
  assert.equal(p.peak, 28);
  assert.equal(p.limits[2].scoped, true);
});

test('parseUsage falls back to five_hour / seven_day', () => {
  const p = parseUsage({ five_hour: fixture.five_hour, seven_day: fixture.seven_day });
  assert.deepEqual(p.limits.map((l) => l.label), ['session', 'week']);
});

test('formatLine: one line, scoped limit omits a reset equal to the weekly one', () => {
  const now = new Date(2030, 0, 7, 10, 0);
  const line = formatLine(parseUsage(fixture), now);
  assert.match(line, /^session 28% \(resets \S.*\) · week 25% \(resets \w{3} \d\d:\d\d\) · Fable 7%$/);
});

test('formatReset: same day shows HH:MM, later shows weekday', () => {
  const now = new Date(2030, 0, 7, 10, 0);
  assert.equal(formatReset(new Date(2030, 0, 7, 16, 30), now), '16:30');
  assert.equal(formatReset(new Date(2030, 0, 10, 8, 0), now), 'Thu 08:00');
});

const reading = (session, week, model = 0, reset = '2030-01-07T13:30:00Z') => parseUsage({ limits: [
  { kind: 'session', percent: session, resets_at: reset },
  { kind: 'weekly_all', percent: week, resets_at: '2030-01-10T08:00:00Z' },
  { kind: 'weekly_scoped', percent: model, resets_at: '2030-01-10T08:00:00Z', scope: { model: { display_name: 'Fable' } } },
] });

test('decide: below threshold stays ok', () => {
  const r = decide(null, reading(50, 40), { threshold: 95, now: new Date('2030-01-07T10:00:00Z') });
  assert.equal(r.state.status, 'ok'); assert.equal(r.transition, null);
});

test('decide: crossing pauses until the latest reset among limits over threshold', () => {
  const r = decide({ status: 'ok' }, reading(96, 40), { threshold: 95, now: new Date('2030-01-07T10:00:00Z') });
  assert.equal(r.transition, 'pause');
  assert.equal(r.state.status, 'paused');
  assert.equal(r.state.resumes_at, '2030-01-07T13:30:00.000Z');
  assert.match(r.state.reason, /session 96%/);
});

test('decide: scoped model limit counts unless ignored', () => {
  const now = new Date('2030-01-07T10:00:00Z');
  assert.equal(decide(null, reading(10, 10, 97), { now }).transition, 'pause');
  assert.equal(decide(null, reading(10, 10, 97), { now, includeScoped: false }).transition, null);
});

test('decide: stays paused near the limit before reset, resumes after reset or with real headroom', () => {
  const paused = { status: 'paused', kind: 'limit', resumes_at: '2030-01-07T13:30:00.000Z', percent: 96 };
  const before = decide(paused, reading(90, 40), { now: new Date('2030-01-07T13:00:00Z') });
  assert.equal(before.state.status, 'paused'); assert.equal(before.transition, null);
  const headroom = decide(paused, reading(20, 40), { now: new Date('2030-01-07T13:00:00Z') });
  assert.equal(headroom.state.status, 'ok'); assert.equal(headroom.transition, 'resume');
  const after = decide(paused, reading(0, 40), { now: new Date('2030-01-07T13:31:00Z') });
  assert.equal(after.state.status, 'ok'); assert.equal(after.transition, 'resume');
  const still = decide(paused, reading(99, 40, 0, '2030-01-07T18:30:00Z'), { now: new Date('2030-01-07T13:31:00Z') });
  assert.equal(still.state.status, 'paused'); assert.equal(still.state.resumes_at, '2030-01-07T18:30:00.000Z');
});

test('nextIntervalSec: faster near threshold, wakes after reset when paused', () => {
  assert.equal(nextIntervalSec({ percent: 20 }, { base: 120 }), 300);
  assert.equal(nextIntervalSec({ percent: 85 }, { base: 120 }), 90);
  assert.equal(nextIntervalSec({ percent: 92 }, { base: 120 }), 60); // never below 60 s (endpoint 429s)
  const now = new Date('2030-01-07T13:29:00Z');
  assert.equal(nextIntervalSec({ status: 'paused', resumes_at: '2030-01-07T13:30:00Z' }, { base: 120, now }), 65);
});

test('fetchUsage: expired token and 401 are AuthError, transport failure is NetworkError', async () => {
  await assert.rejects(fetchUsage({ accessToken: 'x', expiresAt: 1 }, { now: 2 }), AuthError);
  await assert.rejects(fetchUsage({ accessToken: 'x' }, { fetchImpl: async () => ({ status: 401, ok: false }) }), AuthError);
  await assert.rejects(fetchUsage({ accessToken: 'x' }, { fetchImpl: async () => { throw new TypeError('fetch failed'); } }), NetworkError);
  let headers;
  const json = await fetchUsage({ accessToken: 'x' }, { fetchImpl: async (_u, o) => { headers = o.headers; return { status: 200, ok: true, json: async () => fixture }; } });
  assert.equal(headers['anthropic-beta'], 'oauth-2025-04-20');
  assert.equal(json.limits.length, 3);
});

test('readCredentials: .credentials.json on non-macOS', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cu-'));
  assert.throws(() => readCredentials(dir, { platform: 'linux' }), AuthError);
  writeFileSync(join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'test-token', expiresAt: 0, subscriptionType: 'max' } }));
  const c = readCredentials(dir, { platform: 'linux' });
  assert.equal(c.source, 'file'); assert.equal(c.subscriptionType, 'max');
});

test('formatResetIn: session reset as relative time', () => {
  const now = new Date(2030, 0, 7, 15, 0);
  assert.equal(formatResetIn(new Date(2030, 0, 7, 16, 31), now), 'in 1 hr 31 min');
  assert.equal(formatResetIn(new Date(2030, 0, 7, 15, 45), now), 'in 45 min');
  assert.equal(formatResetIn(new Date(2030, 0, 7, 17, 0), now), 'in 2 hr');
});

test('formatPretty: bars, percent and session reset without colour', () => {
  const now = new Date(2030, 0, 7, 15, 0);
  const parsed = { limits: [
    { label: 'session', kind: 'session', percent: 30, resetsAt: new Date(2030, 0, 7, 16, 31), scoped: false },
    { label: 'week', kind: 'weekly_all', percent: 85, resetsAt: new Date(2030, 0, 10, 8, 0), scoped: false },
  ] };
  const out = formatPretty(parsed, { now, color: false, width: 10 }).split('\n');
  assert.equal(out[0], 'Claude usage');
  assert.equal(out[1], '  Session   ███░░░░░░░  30%  Resets in 1 hr 31 min');
  assert.equal(out[2], '  Week      █████████░  85%  Resets Thu 08:00');
  assert.ok(!out.join('').includes('\x1b['));
});

test('fetchUsage: HTTP 429 is a RateLimitError carrying Retry-After', async () => {
  const { fetchUsage, RateLimitError } = await import('../lib/core.mjs');
  const creds = { accessToken: 'x', expiresAt: Date.now() + 3600e3 };
  const res = { status: 429, ok: false, headers: { get: (h) => (h === 'retry-after' ? '120' : null) } };
  await assert.rejects(fetchUsage(creds, { fetchImpl: async () => res }), (e) => e instanceof RateLimitError && e.retryAfterSec === 120);
});

test('getUsage: fresh cache is reused; on 429 a recent cache is returned as stale', async () => {
  const { getUsage, cachePath } = await import('../lib/core.mjs');
  const { mkdtempSync, writeFileSync, mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join, dirname } = await import('node:path');
  process.env.CLAUDE_USAGE_CACHE_DIR = mkdtempSync(join(tmpdir(), 'cu-cache-'));
  const dir = '/nonexistent/.claude-test';
  const now = Date.parse('2030-01-07T12:00:00Z');
  const p = cachePath(dir); mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ fetched_at: new Date(now - 30e3).toISOString(), json: { five_hour: { utilization: 42 } } }));
  let called = 0;
  const fresh = await getUsage(dir, { now, fetchImpl: async () => { called++; } });
  assert.equal(fresh.cached, true); assert.equal(called, 0);
  assert.equal(fresh.json.five_hour.utilization, 42);
  delete process.env.CLAUDE_USAGE_CACHE_DIR;
});

const lim = (session, t) => ({ limits: [{ label: 'session', kind: 'session', percent: session, resetsAt: t, scoped: false }] });
test('decide: pauses early when the burn rate would cross the threshold before the next check', () => {
  const t0 = new Date('2030-01-07T12:00:00Z'), reset = new Date('2030-01-07T14:00:00Z');
  let st = decide(null, lim(85, reset), { now: t0 }).state;
  const t1 = new Date(t0.getTime() + 5 * 60e3);           // +5 %/5 min = 1 %/min
  const r = decide(st, lim(90, reset), { now: t1, nextCheckSec: 120 }); // 90 + 1 %/min × 5 min = 95
  assert.equal(r.state.status, 'paused'); assert.equal(r.transition, 'pause'); assert.equal(r.state.kind, 'projected');
  assert.match(r.state.reason, /rising 1\.0%\/min/);
});
test('decide: a fresh reading with real headroom lifts a pause early (account switch)', () => {
  const now = new Date('2030-01-07T12:00:00Z');
  const prev = { status: 'paused', kind: 'limit', reason: 'session 100%', percent: 100, resumes_at: '2030-01-07T13:00:00Z', updated_at: now.toISOString() };
  const r = decide(prev, lim(26, new Date('2030-01-07T16:00:00Z')), { now });
  assert.equal(r.state.status, 'ok'); assert.equal(r.transition, 'resume');
  const stay = decide(prev, lim(90, new Date('2030-01-07T13:00:00Z')), { now });
  assert.equal(stay.state.status, 'paused');               // 90 is not real headroom
});
test('decide: warn transition once at 80%', () => {
  const now = new Date('2030-01-07T12:00:00Z');
  const a = decide({ status: 'ok', percent: 70 }, lim(81, now), { now });
  assert.equal(a.transition, 'warn'); assert.equal(a.state.warn, true);
  assert.equal(decide(a.state, lim(82, now), { now: new Date(now.getTime() + 10e3) }).transition, null);
});
test('decideUnknown: pauses when unreadable near the limit, not when far', () => {
  const now = new Date('2030-01-07T12:10:00Z');
  const old = '2030-01-07T12:00:00Z';
  const u = decideUnknown({ status: 'ok', percent: 89, updated_at: old }, { now });
  assert.equal(u.state.status, 'paused'); assert.equal(u.state.kind, 'unknown');
  assert.equal(decideUnknown({ status: 'ok', percent: 40, updated_at: old }, { now }), null);
});
