# Changelog

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
