# Changelog

## 1.4.0 — 2026-10-17

- Shared 60 s on-disk cache (`~/.claude-usage/cache/`): the CLI, skill, monitor and other tools reuse one recent answer instead of each calling the rate-limited endpoint. `--fresh` bypasses it.
- HTTP 429 handling: `RateLimitError` honours `Retry-After`; the monitor backs off 5 → 10 → 15 min and keeps the last known state; a recent cached answer is served (marked stale) instead of an error.
- Near the threshold the monitor polls at most once a minute (was every 30 s, which triggered 429s).

## 1.3.0 — 2026-10-17

- pause-guard now holds tool calls while paused and releases them after the reset, so work resumes automatically where it stopped. `CLAUDE_USAGE_GUARD=block` keeps the old stop-the-turn behaviour.
- Hook timeout in the examples raised to 7 days so a hold can outlast a weekly reset.

## 1.2.0 — 2026-10-17

- Styled terminal output: a coloured bar per limit (green < 50 %, yellow < 80 %, red ≥ 80 %). Piped output and `--plain` keep the one-line format; `NO_COLOR` drops colours.
- The skill reports usage as a compact Markdown block with bars.

## 1.1.0 — 2026-10-17

- Session (5-hour) reset is shown relative: "resets in 1 hr 31 min".

## 1.0.1 — 2026-10-17

- pause-guard: round the resume time to the nearest minute, matching `claude-usage`.

## 1.0.0 — 2026-10-17

- `claude-usage`: session, weekly and per-model weekly usage from the token Claude Code already stores (macOS keychain or `.credentials.json`); `--json`, `--config-dir`, `--all`; exit codes 0/2/3.
- `claude-usage-monitor`: polls, pauses at a threshold (default 95%), notifies (macOS, notify-send, Telegram), resumes after the reset; `--on-pause`/`--on-resume`, `--once`.
- `hooks/pause-guard.mjs`: PreToolUse hook that blocks tool calls while paused; fails open.
- Claude Code skill (`SKILL.md`), launchd/systemd/cron templates, tests.
