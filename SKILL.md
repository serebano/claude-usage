---
name: claude-usage
description: Check Claude Code subscription usage and rate limits (5-hour session, weekly, per-model weekly such as Fable), and pause work automatically at 95% until the limit resets. Use when asked about usage, "how much quota is left", rate limits, when a limit resets, before starting long or parallel work, or to set up "pause at 95%".
---

# claude-usage

Scripts live next to this file. `<skill dir>` below is this skill's base directory
(shown when the skill loads; usually `~/.claude/skills/claude-usage`).

## Check usage

```bash
node "<skill dir>/bin/claude-usage.mjs" --json
```

Report it as a small Markdown block, one row per limit, with a 10-cell bar
(`█` filled, `░` empty), the percent in bold, and the reset (session relative, others local time):

```
**Claude usage**
`Session ███░░░░░░░` **30%** · resets in 1 hr 25 min
`Week    ███░░░░░░░` **26%** · resets Fri 08:00
`Fable   █░░░░░░░░░` **10%**
```

Add ⚠️ after the percent at 80% or more, 🛑 at 95% or more. In a terminal the CLI prints
coloured bars itself; piped or with `--plain` it prints one line
(`session 30% (resets in 1 hr 25 min) · week 26% (resets Fri 08:00) · Fable 10%`).
If `CLAUDE_CONFIG_DIR` is set it is used; otherwise pass
`--config-dir <dir>`. `--all` checks every `~/.claude*` config dir.

Exit codes: `0` ok · `2` token expired or not logged in (it refreshes the next time Claude
Code makes a request; do not try to refresh it) · `3` network error.

Never print or copy the OAuth token or the credentials file. Only report the numbers.

## Plan around the numbers

- Above 80% on any limit: prefer smaller steps, avoid starting many parallel agents.
- At or above 95%: stop at a clean point, write progress notes, tell the user the reset time.

## Monitor and pause at 95%

```bash
node "<skill dir>/bin/claude-usage-monitor.mjs" --threshold 95          # foreground
node "<skill dir>/bin/claude-usage-monitor.mjs" --once                  # one check (cron)
```

It writes `~/.claude-usage/state.json` (`status: ok|paused`, `reason`, `percent`,
`resumes_at`), logs events to `~/.claude-usage/events.log`, sends a desktop notification
(and Telegram when `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are set), and runs
`--on-pause` / `--on-resume` commands. Run it as a service with the templates in
`examples/` (launchd, systemd, cron).

## Pause guard (PreToolUse hook)

`hooks/pause-guard.mjs` holds every tool call while the state is `paused` and the reset is
in the future, then lets it run once the monitor reports `ok` (or the reset has passed).
Sessions and subagents pause at 95% and continue by themselves after the reset; nothing
is lost. It reads only the local state file and allows everything if the file is missing,
corrupt or stale. The long hook `timeout` lets a hold last until a weekly reset.
`CLAUDE_USAGE_GUARD=block` stops the turn instead (exit 2); `off` disables it.

Enable it only when the user asks. Add to `settings.json` (see `examples/settings.hooks.json`):

```json
{ "hooks": { "PreToolUse": [ { "matcher": "*", "hooks": [
  { "type": "command", "command": "node ~/.claude/skills/claude-usage/hooks/pause-guard.mjs", "timeout": 604800 }
] } ] } }
```

Bypass once: `CLAUDE_USAGE_GUARD=off`.
