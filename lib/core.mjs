// Core helpers: credential lookup, the usage request, parsing, formatting and
// the pause/resume decision. Zero dependencies. The OAuth token is read here and
// sent only to api.anthropic.com. It is never printed, logged or written.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';

export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
export const BETA_HEADER = 'oauth-2025-04-20';
export const EXIT = { OK: 0, ERROR: 1, AUTH: 2, NETWORK: 3 };

export class AuthError extends Error { constructor(m) { super(m); this.code = EXIT.AUTH; } }
export class NetworkError extends Error { constructor(m) { super(m); this.code = EXIT.NETWORK; } }
// HTTP 429 from the usage API; retryAfterSec comes from Retry-After when present.
export class RateLimitError extends NetworkError {
  constructor(retryAfterSec) { super(`usage API rate-limited (HTTP 429)${retryAfterSec ? `, retry after ${retryAfterSec}s` : ''}`); this.retryAfterSec = retryAfterSec; }
}

export const AUTH_EXPIRED_MSG =
  'token expired — it refreshes the next time Claude Code makes a request';

export function expandHome(p, home = homedir()) {
  if (!p) return p;
  if (p === '~') return home;
  if (p.startsWith('~/')) return join(home, p.slice(2));
  return p;
}

export function defaultConfigDir(env = process.env, home = homedir()) {
  return env.CLAUDE_CONFIG_DIR ? normalizeDir(env.CLAUDE_CONFIG_DIR, home) : join(home, '.claude');
}

export function normalizeDir(p, home = homedir()) {
  let d = resolve(expandHome(p, home));
  while (d.length > 1 && d.endsWith('/')) d = d.slice(0, -1);
  return d;
}

// Keychain service names the CLI uses. The default config dir uses the bare
// name; any CLAUDE_CONFIG_DIR adds the first 8 hex chars of sha256(path).
export function keychainServiceNames(configDir, home = homedir()) {
  const base = 'Claude Code-credentials';
  const suffixed = `${base}-${createHash('sha256').update(configDir).digest('hex').slice(0, 8)}`;
  return configDir === join(home, '.claude') ? [base, suffixed] : [suffixed];
}

function readKeychain(service) {
  try {
    return execFileSync('security', ['find-generic-password', '-s', service, '-w'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch { return null; }
}

// Returns { accessToken, expiresAt, subscriptionType, source } or throws AuthError.
export function readCredentials(configDir, { platform = process.platform, home = homedir() } = {}) {
  const raws = [];
  if (platform === 'darwin') {
    for (const s of keychainServiceNames(configDir, home)) {
      const r = readKeychain(s);
      if (r) { raws.push([r, 'keychain']); break; }
    }
  }
  const file = join(configDir, '.credentials.json');
  if (!raws.length && existsSync(file)) raws.push([readFileSync(file, 'utf8'), 'file']);
  if (!raws.length) throw new AuthError(`not logged in (no credentials for ${configDir}) — run \`claude\` and /login`);
  let oauth;
  try { oauth = JSON.parse(raws[0][0]).claudeAiOauth; } catch { oauth = null; }
  if (!oauth?.accessToken) throw new AuthError('credentials found but no claude.ai OAuth token — log in with a Claude subscription');
  return {
    accessToken: oauth.accessToken,
    expiresAt: oauth.expiresAt ?? null,
    subscriptionType: oauth.subscriptionType ?? null,
    source: raws[0][1],
  };
}

export function findConfigDirs(home = homedir()) {
  let names = [];
  try { names = readdirSync(home); } catch { /* ignore */ }
  return names
    .filter((n) => n === '.claude' || /^\.claude-[^/]+$/.test(n))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
    .map((n) => join(home, n));
}

// Shared on-disk cache so every caller (CLI, skill, monitor, channel) reuses one recent
// answer instead of each hitting the rate-limited endpoint. Holds usage numbers only.
export function cachePath(configDir, home = homedir()) {
  const key = createHash('sha256').update(String(configDir)).digest('hex').slice(0, 8);
  return join(process.env.CLAUDE_USAGE_CACHE_DIR || join(home, '.claude-usage', 'cache'), `${key}.json`);
}
export function readCache(configDir) {
  try { const c = JSON.parse(readFileSync(cachePath(configDir), 'utf8')); return c?.fetched_at && c.json ? c : null; } catch { return null; }
}
function writeCache(configDir, json, now) {
  try {
    const p = cachePath(configDir); mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ fetched_at: new Date(now).toISOString(), json }));
  } catch { /* cache is best effort */ }
}
// Fresh cache (< maxAgeMs) wins; otherwise fetch. On HTTP 429 a cached answer up to
// staleOkMs old is returned (marked stale) rather than failing.
export async function getUsage(configDir, { maxAgeMs = 60e3, staleOkMs = 15 * 60e3, now = Date.now(), fetchImpl } = {}) {
  const c = readCache(configDir);
  const age = c ? now - Date.parse(c.fetched_at) : Infinity;
  if (c && age < maxAgeMs) return { json: c.json, fetchedAt: c.fetched_at, cached: true };
  try {
    const json = await fetchUsage(readCredentials(configDir), { now, ...(fetchImpl ? { fetchImpl } : {}) });
    writeCache(configDir, json, now);
    return { json, fetchedAt: new Date(now).toISOString(), cached: false };
  } catch (e) {
    if (e instanceof RateLimitError && c && age < staleOkMs) return { json: c.json, fetchedAt: c.fetched_at, cached: true, stale: true, rateLimited: e };
    throw e;
  }
}

export async function fetchUsage(creds, { now = Date.now(), fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  if (creds.expiresAt && creds.expiresAt < now) throw new AuthError(AUTH_EXPIRED_MSG);
  let res;
  try {
    res = await fetchImpl(USAGE_URL, {
      headers: { Authorization: `Bearer ${creds.accessToken}`, 'anthropic-beta': BETA_HEADER },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new NetworkError(`network error: ${e?.name === 'TimeoutError' ? 'timeout' : e?.cause?.code || e?.message || e}`);
  }
  if (res.status === 401 || res.status === 403) throw new AuthError(AUTH_EXPIRED_MSG);
  if (res.status === 429) {
    const ra = Number(res.headers?.get?.('retry-after'));
    throw new RateLimitError(Number.isFinite(ra) && ra > 0 ? Math.ceil(ra) : null);
  }
  if (!res.ok) throw new NetworkError(`usage API returned HTTP ${res.status}`);
  try { return await res.json(); } catch { throw new NetworkError('usage API returned invalid JSON'); }
}

function labelFor(l) {
  if (l.kind === 'session') return 'session';
  if (l.kind === 'weekly_all') return 'week';
  const s = l.scope || {};
  return s.model?.display_name || s.model?.id || s.surface?.display_name || s.surface || l.kind || 'limit';
}

function toDate(v) { const d = v ? new Date(v) : null; return d && !isNaN(d) ? d : null; }

// Normalises the response into [{ label, kind, group, percent, resetsAt, active, scoped }].
export function parseUsage(json) {
  let limits = [];
  if (Array.isArray(json?.limits) && json.limits.length) {
    limits = json.limits
      .filter((l) => typeof l?.percent === 'number')
      .map((l) => ({
        label: labelFor(l),
        kind: l.kind ?? null,
        group: l.group ?? null,
        percent: l.percent,
        severity: l.severity ?? null,
        resetsAt: toDate(l.resets_at),
        active: !!l.is_active,
        scoped: !!l.scope,
      }));
  } else {
    if (json?.five_hour?.utilization != null) limits.push({ label: 'session', kind: 'session', group: 'session', percent: json.five_hour.utilization, severity: null, resetsAt: toDate(json.five_hour.resets_at), active: false, scoped: false });
    if (json?.seven_day?.utilization != null) limits.push({ label: 'week', kind: 'weekly_all', group: 'weekly', percent: json.seven_day.utilization, severity: null, resetsAt: toDate(json.seven_day.resets_at), active: false, scoped: false });
  }
  return { limits, peak: peakPercent(limits) };
}

export function peakPercent(limits, { includeScoped = true } = {}) {
  const ps = limits.filter((l) => includeScoped || !l.scoped).map((l) => l.percent);
  return ps.length ? Math.max(...ps) : 0;
}

const pad = (n) => String(n).padStart(2, '0');
export function formatReset(date, now = new Date()) {
  if (!date) return '';
  date = new Date(Math.round(date.getTime() / 60e3) * 60e3); // 13:29:59.8 -> 13:30
  const hm = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (date - now < 20 * 3600e3 && date.getDate() === now.getDate()) return hm;
  if (date - now < 24 * 3600e3) return `tomorrow ${hm}`;
  return `${date.toLocaleDateString('en-US', { weekday: 'short' })} ${hm}`;
}

// Relative reset for the 5-hour session window, as Claude shows it: "in 1 hr 31 min", "in 45 min".
export function formatResetIn(date, now = new Date()) {
  if (!date) return '';
  const mins = Math.max(0, Math.round((date.getTime() - now.getTime()) / 60e3));
  const h = Math.floor(mins / 60), m = mins % 60;
  if (h && m) return `in ${h} hr ${m} min`;
  if (h) return `in ${h} hr`;
  return `in ${m} min`;
}

export function formatLine(parsed, now = new Date()) {
  const parts = [];
  const shown = new Set();
  for (const l of parsed.limits) {
    let s = `${l.label} ${Math.round(l.percent)}%`;
    // scoped limits usually share the weekly reset; only show a time when it differs
    const sameAsWeek = l.scoped && parsed.limits.some((o) => o.kind === 'weekly_all' && o.resetsAt && l.resetsAt && Math.abs(o.resetsAt - l.resetsAt) < 60e3);
    if (l.resetsAt && !sameAsWeek) s += l.kind === 'session'
      ? ` (resets ${formatResetIn(l.resetsAt, now)})`
      : ` (resets ${formatReset(l.resetsAt, now)})`;
    if (!shown.has(s)) { parts.push(s); shown.add(s); }
  }
  return parts.length ? parts.join(' · ') : 'no usage limits reported';
}

// Styled multi-line view for an interactive terminal: a bar per limit, coloured by level.
// color: true adds ANSI colours (green < 50 %, yellow < 80 %, red >= 80 %).
export function formatPretty(parsed, { now = new Date(), color = true, title = 'Claude usage', width = 20 } = {}) {
  const c = (code, t) => (color ? `\x1b[${code}m${t}\x1b[0m` : t);
  const level = (p) => (p >= 80 ? '31' : p >= 50 ? '33' : '32');
  const rows = [];
  const seen = new Set();
  for (const l of parsed.limits) {
    const pct = Math.max(0, Math.min(100, Math.round(l.percent)));
    const key = `${l.label}|${pct}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const filled = Math.round((pct / 100) * width);
    const bar = c(level(pct), '█'.repeat(filled)) + c('2', '░'.repeat(width - filled));
    const sameAsWeek = l.scoped && parsed.limits.some((o) => o.kind === 'weekly_all' && o.resetsAt && l.resetsAt && Math.abs(o.resetsAt - l.resetsAt) < 60e3);
    const reset = !l.resetsAt || sameAsWeek ? ''
      : l.kind === 'session' ? `Resets ${formatResetIn(l.resetsAt, now)}` : `Resets ${formatReset(l.resetsAt, now)}`;
    const name = l.label.charAt(0).toUpperCase() + l.label.slice(1);
    rows.push(`  ${c('1', name.padEnd(9))} ${bar} ${c(`1;${level(pct)}`, `${String(pct).padStart(3)}%`)}${reset ? '  ' + c('2', reset) : ''}`);
  }
  if (!rows.length) return 'no usage limits reported';
  return [c('1', title), ...rows].join('\n');
}

export function toJSON(parsed, extra = {}) {
  return {
    ...extra,
    peak: parsed.peak,
    limits: parsed.limits.map((l) => ({
      label: l.label, kind: l.kind, group: l.group, percent: l.percent, severity: l.severity,
      resets_at: l.resetsAt ? l.resetsAt.toISOString() : null, active: l.active,
    })),
    fetched_at: new Date().toISOString(),
  };
}

// Pause/resume decision. Pure: given the previous state and a fresh reading,
// returns { state, transition: 'pause' | 'resume' | null }.
export function decide(prev, parsed, { threshold = 95, now = new Date(), includeScoped = true } = {}) {
  const status = prev?.status === 'paused' ? 'paused' : 'ok';
  const over = parsed.limits.filter((l) => (includeScoped || !l.scoped) && l.percent >= threshold);
  const peak = peakPercent(parsed.limits, { includeScoped });
  const stamp = now.toISOString();
  const latestReset = (ls) => {
    const ds = ls.map((l) => l.resetsAt).filter(Boolean);
    return ds.length ? new Date(Math.max(...ds)).toISOString() : null;
  };
  const reasonOf = (ls) => ls.map((l) => `${l.label} ${Math.round(l.percent)}%`).join(', ');

  if (over.length) {
    const state = { status: 'paused', reason: reasonOf(over), percent: peak, resumes_at: latestReset(over), updated_at: stamp };
    return { state, transition: status === 'paused' ? null : 'pause' };
  }
  if (status === 'paused') {
    const resumesAt = prev.resumes_at ? new Date(prev.resumes_at) : null;
    if (!resumesAt || isNaN(resumesAt) || now >= resumesAt) {
      return { state: { status: 'ok', reason: null, percent: peak, resumes_at: null, updated_at: stamp }, transition: 'resume' };
    }
    return { state: { ...prev, percent: peak, updated_at: stamp }, transition: null };
  }
  return { state: { status: 'ok', reason: null, percent: peak, resumes_at: null, updated_at: stamp }, transition: null };
}

// Seconds until the next poll: faster near the threshold, and wake right after
// a pending reset while paused.
export function nextIntervalSec(state, { base = 120, threshold = 95, now = new Date() } = {}) {
  if (state?.status === 'paused' && state.resumes_at) {
    const until = Math.ceil((new Date(state.resumes_at) - now) / 1000) + 5;
    return Math.max(15, Math.min(base * 5, until));
  }
  const p = state?.percent ?? 0;
  // The usage endpoint rate-limits (HTTP 429) below one call a minute; never poll faster.
  if (p >= threshold - 5) return Math.max(60, Math.min(base, 60));
  if (p >= threshold - 15) return Math.max(60, Math.min(base, 90));
  return base;
}
