#!/usr/bin/env node
// Claude Code PreToolUse hook. Reads the monitor's local state file only.
//
// While the state is "paused" and the reset is still ahead, the tool call is
// held: the hook waits (re-reading the state every 15 s) until the monitor
// reports "ok" or the reset time has passed, then allows it. The session and
// its subagents simply continue after the reset: auto pause, auto resume.
//
// CLAUDE_USAGE_GUARD=block  exit 2 instead of waiting (Claude stops its turn)
// CLAUDE_USAGE_GUARD=off    allow everything
// Anything unreadable or stale -> allow (fail open).
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const path = process.env.CLAUDE_USAGE_STATE || join(homedir(), '.claude-usage', 'state.json');
const mode = process.env.CLAUDE_USAGE_GUARD || 'wait';
const POLL_MS = Number(process.env.CLAUDE_USAGE_GUARD_POLL_MS) || 15e3;
const GRACE_MS = 60e3; // let the monitor confirm the reset before work restarts

// Returns the reset Date while paused, or null when work may go ahead.
function pausedUntil() {
  let s;
  try { s = JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
  if (s?.status !== 'paused') return null;
  const resumes = s.resumes_at ? new Date(s.resumes_at) : null;
  // A reset time in the past means the monitor has not caught up (or is not
  // running); do not hold work hostage to a stale file.
  if (!resumes || isNaN(resumes) || resumes.getTime() + GRACE_MS <= Date.now()) return null;
  return { resumes, state: s };
}

if (mode === 'off') process.exit(0);
const first = pausedUntil();
if (!first) process.exit(0);

const r = new Date(Math.round(first.resumes.getTime() / 60e3) * 60e3); // 07:59:59.8 -> 08:00
const pad = (n) => String(n).padStart(2, '0');
const at = `${r.toLocaleDateString('en-US', { weekday: 'short' })} ${pad(r.getHours())}:${pad(r.getMinutes())}`;
const why = first.state.reason || `${first.state.percent}%`;

if (mode === 'block') {
  process.stderr.write(
    `Usage limit ${first.state.threshold ?? 95}% reached (${why}) — paused until ${at}. ` +
    `Stop here: save progress notes, do not retry tool calls, and tell the user where you stopped.\n`,
  );
  process.exit(2);
}

// wait mode: hold this tool call until the pause lifts.
while (pausedUntil()) await sleep(POLL_MS);
process.exit(0);
