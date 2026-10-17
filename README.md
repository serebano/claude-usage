# claude-usage

See your Claude Code subscription usage (5-hour session, weekly, and per-model weekly
limits) from the terminal or from inside Claude, and pause all sessions at 95% until the
limit resets. It reads the login Claude Code already stored and calls the same usage
endpoint the CLI's `/usage` screen uses. Zero dependencies, Node 18+. It also works as a
Claude Code skill, so Claude can check its own quota.

```
$ claude-usage
Claude usage · max
  Session   ██████░░░░░░░░░░░░░░  30%  Resets in 1 hr 25 min
  Week      █████░░░░░░░░░░░░░░░  26%  Resets Fri 08:00
  Fable     ██░░░░░░░░░░░░░░░░░░  10%
```

## Quick use

```bash
# as a Claude Code skill (Claude can then answer "how much usage is left?")
git clone https://github.com/serebano/claude-usage ~/.claude/skills/claude-usage

# or run without installing
npx github:serebano/claude-usage
```

```bash
claude-usage                          # one-line summary (local time)
claude-usage --plain                             # one line (default when piped)
claude-usage --json                   # machine-readable
claude-usage --config-dir ~/.claude-2 # a specific CLAUDE_CONFIG_DIR
claude-usage --all                    # every ~/.claude* config dir
claude-usage-monitor --threshold 95   # pause at 95%, notify, resume after reset
claude-usage-monitor --once           # single check, for cron/timers
claude-usage-monitor --on-pause 'say paused' --on-resume 'say resumed'
```

From a clone, use `node bin/claude-usage.mjs` (or `npm link` once to get the commands).
Exit codes: `0` ok, `2` token expired / not logged in, `3` network error.

## Pause at 95%

The monitor writes `~/.claude-usage/state.json`. The PreToolUse hook
`hooks/pause-guard.mjs` blocks tool calls while it says `paused`, so every session and
agent stops cleanly with "Usage limit 95% reached — paused until <time>" instead of
failing mid-task. After the reset the monitor sets `ok`, notifies, and runs `--on-resume`
(use it to nudge your sessions). The hook reads only that local file and fails open.
Enable it with [`examples/settings.hooks.json`](examples/settings.hooks.json); run the
monitor as a service with the launchd/systemd/cron templates in [`examples/`](examples/).
Notifications: macOS Notification Center, `notify-send` on Linux, and Telegram when
`TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are set.

## How it works

- **Token**: macOS keychain item `Claude Code-credentials` (for a custom
  `CLAUDE_CONFIG_DIR`: `Claude Code-credentials-<first 8 hex of sha256(dir path)>`);
  elsewhere `<config dir>/.credentials.json`. Windows: the same file under
  `%USERPROFILE%\.claude`, best-effort.
- **Request**: `GET https://api.anthropic.com/api/oauth/usage` with
  `Authorization: Bearer <token>` and `anthropic-beta: oauth-2025-04-20`. The `limits[]`
  array gives each limit's percent and reset time.
- It never refreshes the token (refresh tokens rotate and that would log the CLI out).
  An expired token is reported; Claude Code refreshes it on its next request.

## Privacy

The token is read locally and sent only to `api.anthropic.com`. It is never printed,
logged or written to disk. Output contains only usage numbers and reset times.

## Disclaimer

Unofficial and not affiliated with Anthropic. It uses an undocumented endpoint that may
change or disappear without notice.

MIT licensed. See [CHANGELOG.md](CHANGELOG.md).
