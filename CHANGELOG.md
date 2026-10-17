# Changelog

## 1.5.1 — 2026-10-18

- Monitor: a stale cached answer served during HTTP 429 no longer counts as a fresh reading. It used to refresh `updated_at` and the burn-rate history, so the blind-near-limit pause never fired and the pause came only at exactly 95%.

## 1.5.0 — 2026-10-17

Fixes a missed auto-pause: the window burned from 89% to 100% while the monitor was blind on HTTP 429s.
- **Rate-aware pause:** the monitor tracks each limit's burn rate (%/min) and pauses when the next check would come too late, not only at the threshold.
- **Unknown near the limit = pause:** if the last reading was ≥85% and the endpoint can't be read (429/network) for 3 min, it pauses until a fresh safe reading.
- **A fresh reading decides:** a pause lifts as soon as a reading shows real headroom (10 points under the threshold, e.g. after an account switch), not only at the reset time.
- **Warn at 80%:** a notification, and the pause guard refuses NEW subagents (Agent/Task) while current work continues.
- **Guard fails open on a stale state** (monitor not updating for 20 min).
- **Gentler polling:** 5 min under 50%, 3 min to 80%, 90 s to 90%, 60 s above; the 429 backoff is capped at 3 min near the limit.
- **`--all` is sequential** (1.5 s apart) and reuses answers up to 5 min old; a burst across accounts was what triggered the 429s.

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
