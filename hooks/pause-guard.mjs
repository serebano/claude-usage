#!/usr/bin/env node
// Claude Code PreToolUse hook. Reads the monitor's local state file only.
// paused (and the reset is still in the future) -> exit 2, which blocks the
// tool call and shows the reason to Claude. Anything else -> allow (fail open).
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const path = process.env.CLAUDE_USAGE_STATE || join(homedir(), '.claude-usage', 'state.json');
let s = null;
try { s = JSON.parse(readFileSync(path, 'utf8')); } catch { process.exit(0); }
if (process.env.CLAUDE_USAGE_GUARD === 'off' || s?.status !== 'paused') process.exit(0);

const resumes = s.resumes_at ? new Date(s.resumes_at) : null;
// A reset time in the past means the monitor has not caught up (or is not
// running); do not hold work hostage to a stale file.
if (!resumes || isNaN(resumes) || resumes <= new Date()) process.exit(0);

const r = new Date(Math.round(resumes.getTime() / 60e3) * 60e3); // 07:59:59.8 -> 08:00
const pad = (n) => String(n).padStart(2, '0');
const at = `${r.toLocaleDateString('en-US', { weekday: 'short' })} ${pad(r.getHours())}:${pad(r.getMinutes())}`;
const limit = s.threshold ?? 95;
process.stderr.write(
  `Usage limit ${limit}% reached (${s.reason || `${s.percent}%`}) — paused until ${at}; ` +
  `work resumes automatically after the reset. Stop here: save progress notes, do not retry tool calls, ` +
  `and tell the user where you stopped.\n`,
);
process.exit(2);
