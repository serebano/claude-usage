#!/usr/bin/env node
// claude-usage-monitor: poll usage; at the threshold write a "paused" state
// (which the pause-guard hook enforces), notify, and resume after the reset.
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import {
  EXIT, defaultConfigDir, normalizeDir, getUsage, RateLimitError, parseUsage,
  decide, nextIntervalSec, formatLine, formatReset, expandHome,
} from '../lib/core.mjs';

const HELP = `Usage: claude-usage-monitor [options]

  --threshold <pct>    pause at this percent (default 95)
  --interval <sec>     base poll interval (default 120; faster near the threshold)
  --config-dir <dir>   Claude config dir (default: $CLAUDE_CONFIG_DIR or ~/.claude)
  --state <file>       state file (default ~/.claude-usage/state.json)
  --log <file>         event log (default ~/.claude-usage/events.log)
  --on-pause <cmd>     shell command run on pause
  --on-resume <cmd>    shell command run on resume
  --ignore-scoped      ignore per-model weekly limits (e.g. one model's cap)
  --no-notify          no desktop notification
  --once               check once and exit (for cron / timers)
  -h, --help

Telegram (optional): set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.
Hooks get CLAUDE_USAGE_PERCENT, CLAUDE_USAGE_REASON, CLAUDE_USAGE_RESUMES_AT.`;

let a;
try {
  a = parseArgs({
    options: {
      threshold: { type: 'string', default: '95' }, interval: { type: 'string', default: '120' },
      'config-dir': { type: 'string' }, state: { type: 'string' }, log: { type: 'string' },
      'on-pause': { type: 'string' }, 'on-resume': { type: 'string' },
      'ignore-scoped': { type: 'boolean' }, 'no-notify': { type: 'boolean' },
      once: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    },
  }).values;
} catch (e) { console.error(e.message); console.error(HELP); process.exit(EXIT.ERROR); }
if (a.help) { console.log(HELP); process.exit(0); }

const threshold = Number(a.threshold);
const base = Math.max(15, Number(a.interval) || 120);
const configDir = a['config-dir'] ? normalizeDir(a['config-dir']) : defaultConfigDir();
const home = join(homedir(), '.claude-usage');
const statePath = expandHome(a.state || process.env.CLAUDE_USAGE_STATE || join(home, 'state.json'));
const logPath = expandHome(a.log || join(home, 'events.log'));

const log = (msg) => {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
  try { mkdirSync(dirname(logPath), { recursive: true }); appendFileSync(logPath, line + '\n'); } catch { /* ignore */ }
};

function readState() {
  try { return JSON.parse(readFileSync(statePath, 'utf8')); } catch { return null; }
}
function writeState(s) {
  mkdirSync(dirname(statePath), { recursive: true });
  const tmp = `${statePath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...s, threshold, config_dir: configDir }, null, 2) + '\n');
  renameSync(tmp, statePath); // atomic: the hook never sees a half-written file
}

function run(cmd, env) {
  return new Promise((res) => {
    const p = spawn(cmd, { shell: true, stdio: 'inherit', env: { ...process.env, ...env } });
    p.on('exit', res); p.on('error', res);
  });
}

async function notify(title, body) {
  if (!a['no-notify']) {
    const os = platform();
    if (os === 'darwin') {
      const q = (s) => JSON.stringify(String(s)); // AppleScript string literal
      await run(`osascript -e ${shellQuote(`display notification ${q(body)} with title ${q(title)} sound name "Glass"`)}`);
    } else if (os === 'linux') {
      await run(`command -v notify-send >/dev/null && notify-send ${shellQuote(title)} ${shellQuote(body)} || true`);
    }
  }
  const { TELEGRAM_BOT_TOKEN: tok, TELEGRAM_CHAT_ID: chat } = process.env;
  if (tok && chat) {
    try {
      await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chat, text: `${title}\n${body}` }),
        signal: AbortSignal.timeout(10000),
      });
    } catch { log('telegram notification failed'); }
  }
}
function shellQuote(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

let rateLimit = null; // set when the endpoint answered 429 during this tick
let backoffSec = 0;   // grows on consecutive 429s: 300, 600, 900 (cap)

async function tick() {
  rateLimit = null;
  const prev = readState();
  let parsed;
  try {
    const u = await getUsage(configDir, { maxAgeMs: 30e3 });
    if (u.rateLimited) rateLimit = u.rateLimited;
    parsed = parseUsage(u.json);
  } catch (e) {
    if (e instanceof RateLimitError) rateLimit = e;
    log(`check failed (${e.code === EXIT.AUTH ? 'auth' : e.code === EXIT.NETWORK ? 'network' : 'error'}): ${e.message}`);
    return { state: prev, code: e.code ?? EXIT.ERROR };
  }
  const now = new Date();
  const { state, transition } = decide(prev, parsed, { threshold, now, includeScoped: !a['ignore-scoped'] });
  writeState(state);
  const env = {
    CLAUDE_USAGE_PERCENT: String(state.percent), CLAUDE_USAGE_REASON: state.reason ?? '',
    CLAUDE_USAGE_RESUMES_AT: state.resumes_at ?? '',
  };
  if (transition === 'pause') {
    const when = state.resumes_at ? formatReset(new Date(state.resumes_at), now) : 'the next reset';
    log(`PAUSE ${state.reason}; resumes ${state.resumes_at ?? 'unknown'}`);
    await notify('Claude usage: paused', `${state.reason} reached ${threshold}% limit. Paused until ${when}.`);
    if (a['on-pause']) await run(a['on-pause'], env);
  } else if (transition === 'resume') {
    log(`RESUME ${formatLine(parsed, now)}`);
    await notify('Claude usage: resumed', `Limit reset. ${formatLine(parsed, now)}`);
    if (a['on-resume']) await run(a['on-resume'], env);
  } else if (a.once || process.stdout.isTTY) {
    console.log(`${now.toISOString()} ${state.status} ${formatLine(parsed, now)}`);
  }
  return { state, code: EXIT.OK };
}

if (a.once) {
  const { code } = await tick();
  process.exit(code);
}

log(`monitor started: ${configDir}, threshold ${threshold}%, interval ${base}s`);
let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stopping = true; log('monitor stopped'); process.exit(0); });
while (!stopping) {
  const { state, code } = await tick();
  let sec = code === EXIT.OK ? nextIntervalSec(state, { base, threshold }) : base;
  if (rateLimit) {
    backoffSec = Math.min(900, backoffSec ? backoffSec * 2 : 300);
    sec = Math.max(sec, backoffSec, rateLimit.retryAfterSec ?? 0);
    log(`rate-limited: next check in ${sec}s`);
  } else if (code === EXIT.OK) backoffSec = 0;
  await new Promise((r) => setTimeout(r, sec * 1000));
}
