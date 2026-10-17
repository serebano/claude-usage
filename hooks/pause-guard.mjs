#!/usr/bin/env node
// Claude Code PreToolUse hook. Reads the monitor's local state file only.
//
// paused  -> the tool call is held: the hook waits (re-reading the state every 15 s)
//            until the monitor reports "ok" or the reset has passed, then allows it.
//            Sessions and subagents pause and continue by themselves: auto pause, auto resume.
// warn    -> (usage >= 80 %) starting NEW subagents (Agent/Task tools) is refused, so a
//            nearly spent window is not burned faster; other tools run normally.
//
// CLAUDE_USAGE_GUARD=block  exit 2 instead of waiting (Claude stops its turn)
// CLAUDE_USAGE_GUARD=off    allow everything
// Anything unreadable, stale (monitor not updating) or past its reset -> allow (fail open).
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const path = process.env.CLAUDE_USAGE_STATE || join(homedir(), '.claude-usage', 'state.json');
const mode = process.env.CLAUDE_USAGE_GUARD || 'wait';
const POLL_MS = Number(process.env.CLAUDE_USAGE_GUARD_POLL_MS) || 15e3;
const GRACE_MS = 60e3;            // let the monitor confirm the reset before work restarts
const STALE_MS = 20 * 60e3;       // a state the monitor stopped updating is not trusted
const AGENT_TOOLS = new Set(['Agent', 'Task']);

function readState() {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}
const fresh = (s) => s?.updated_at && Date.now() - Date.parse(s.updated_at) < STALE_MS;

// Returns the reset Date while paused, or null when work may go ahead.
function pausedUntil() {
  const s = readState();
  if (s?.status !== 'paused' || !fresh(s)) return null;
  const resumes = s.resumes_at ? new Date(s.resumes_at) : null;
  if (!resumes || isNaN(resumes) || resumes.getTime() + GRACE_MS <= Date.now()) return null;
  return { resumes, state: s };
}

let tool = '';
try { tool = JSON.parse(readFileSync(0, 'utf8') || '{}').tool_name || ''; } catch { /* no input */ }

if (mode === 'off') process.exit(0);

const st = readState();
if (st?.status === 'ok' && st.warn && fresh(st) && AGENT_TOOLS.has(tool)) {
  process.stderr.write(
    `Usage is at ${Math.round(st.percent)}% (>= 80%): starting new subagents is held to protect the window. ` +
    `Continue the work yourself in small steps, or wait for the reset.\n`,
  );
  process.exit(2);
}

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
