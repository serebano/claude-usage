#!/usr/bin/env node
// claude-usage: print current Claude Code subscription usage (session, weekly,
// per-model weekly) using the token the Claude Code CLI already stored.
import { parseArgs } from 'node:util';
import { basename } from 'node:path';
import {
  EXIT, defaultConfigDir, normalizeDir, findConfigDirs, readCredentials,
  fetchUsage, parseUsage, formatLine, formatPretty, toJSON,
} from '../lib/core.mjs';

const HELP = `Usage: claude-usage [options]

  --json              machine-readable output
  --plain             one line, no colours (default when not a terminal)
  --config-dir <dir>  Claude config dir (default: $CLAUDE_CONFIG_DIR or ~/.claude)
  --all               every config dir found (~/.claude and ~/.claude-*)
  -h, --help          show this help

Exit codes: 0 ok, 2 expired/unauthenticated, 3 network error.`;

let args;
try {
  args = parseArgs({
    options: {
      json: { type: 'boolean' }, plain: { type: 'boolean' }, all: { type: 'boolean' },
      'config-dir': { type: 'string' }, help: { type: 'boolean', short: 'h' },
    },
  }).values;
} catch (e) { console.error(e.message); console.error(HELP); process.exit(EXIT.ERROR); }
if (args.help) { console.log(HELP); process.exit(0); }

async function query(dir) {
  try {
    const creds = readCredentials(dir);
    const parsed = parseUsage(await fetchUsage(creds));
    return { dir, parsed, subscription: creds.subscriptionType };
  } catch (e) {
    return { dir, error: e.message, code: e.code ?? EXIT.ERROR };
  }
}

const dirs = args.all ? findConfigDirs() : [args['config-dir'] ? normalizeDir(args['config-dir']) : defaultConfigDir()];
const results = await Promise.all(dirs.map(query));

if (args.json) {
  const out = results.map((r) => r.error
    ? { config_dir: r.dir, error: r.error, exit_code: r.code }
    : toJSON(r.parsed, { config_dir: r.dir, subscription: r.subscription }));
  console.log(JSON.stringify(args.all ? out : out[0], null, 2));
} else if (!args.plain && process.stdout.isTTY) {
  // Interactive terminal: styled bars (NO_COLOR keeps the layout, drops colour).
  const color = !process.env.NO_COLOR;
  const blocks = results.map((r) => {
    const title = args.all ? basename(r.dir) : `Claude usage${r.subscription ? ' · ' + r.subscription : ''}`;
    if (r.error) return `${color ? '\x1b[1m' + title + '\x1b[0m' : title}\n  ${color ? '\x1b[31m' + r.error + '\x1b[0m' : r.error}`;
    return formatPretty(r.parsed, { color, title });
  });
  console.log(blocks.join('\n\n'));
} else {
  for (const r of results) {
    const prefix = args.all ? `${basename(r.dir).padEnd(10)} ` : '';
    if (r.error) console[args.all ? 'log' : 'error'](`${prefix}${r.error}`);
    else console.log(prefix + formatLine(r.parsed));
  }
}

// Single dir: its exit code. --all: 0 if any succeeded, else the first failure.
const ok = results.some((r) => !r.error);
process.exit(args.all ? (ok ? 0 : results[0]?.code ?? EXIT.ERROR) : (results[0].code ?? 0));
