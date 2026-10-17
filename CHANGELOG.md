# Changelog

## 1.0.0 — 2026-10-17

- `claude-usage`: session, weekly and per-model weekly usage from the token Claude Code already stores (macOS keychain or `.credentials.json`); `--json`, `--config-dir`, `--all`; exit codes 0/2/3.
- `claude-usage-monitor`: polls, pauses at a threshold (default 95%), notifies (macOS, notify-send, Telegram), resumes after the reset; `--on-pause`/`--on-resume`, `--once`.
- `hooks/pause-guard.mjs`: PreToolUse hook that blocks tool calls while paused; fails open.
- Claude Code skill (`SKILL.md`), launchd/systemd/cron templates, tests.
