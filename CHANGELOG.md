# Changelog

## 3.8.0
- Telegram listener is now a managed background service: setup offers **Always-on** (starts hidden now + at every PC start), single-instance guard via pid file, `aion telegram start|stop|status`
- Launching `aion` revives the listener automatically if autostart is on and it died
- `/telegram` in the TUI shows live listener status (pid, autostart) and supports `/telegram start|stop`
- Disconnecting Telegram in setup also stops the listener and removes the autostart task

## 3.7.0
- **Telegram**: `aion telegram setup` links a bot (token + identity verification via message), `aion telegram` runs the long-polling listener with the full agent (tools, memory, typing indicator, 4096-char chunking, stranger lockout), `aion telegram install` autostarts it hidden at every Windows logon (Task Scheduler + VBS; systemd instructions elsewhere)
- **Setup v2**: re-running `aion setup` shows every current setting — Enter keeps it; keep/reconfigure/remove choices for Ollama, providers (removable now), main model, router and Telegram; feature tour no longer replays on re-runs
- `/telegram` in the TUI shows connection status and instructions

## 3.6.0
- Live context gauge in the status bar (`⛁ 12.4k/512k`): token estimate vs auto-detected model window (exact via Ollama `/api/show`, curated table for cloud models)
- `/compact` — summarizes old history via the fast model, keeps the last 4 messages verbatim; auto-compacts at 85% context usage
- `/dream` now shows *what* it learned: extracted facts and evolved genome rules, not just counts
- `/memory` explains the triadic brain (episodic/semantic/procedural/genome) with pointers
- `/stats` shows context usage; context window re-detected on every model switch

## 3.5.0
- `/goal <mission>` — autonomous goal mode: Aion iterates with tools until it verifies completion (safety limit, `resume`, `clear`, `max <n>`)
- `/loop [interval] <prompt>` — recurring prompts; without an interval Aion self-paces the next run; status-bar countdown, `/loop stop`

## 3.4.0
- Animated SVG terminal demo in the README (renders natively on GitHub)
- Per-answer token stats: the meta line shows tokens + tok/s (Ollama & OpenAI-compatible streams)

## 3.3.0
- Multiline input: `Ctrl+J` / `Alt+Enter` / trailing `\` insert newlines, arrows navigate lines, multiline paste preserved, input grows to 6 rows
- GitHub Actions CI: Windows / Ubuntu / macOS × Node 18 / 20 / 22

## 3.2.0
- Cross-platform: `run_shell` uses PowerShell on Windows, `/bin/sh` elsewhere; platform-aware system prompt
- `/sessions` — browse and resume any saved conversation from an overlay picker

## 3.1.0
- Session persistence: auto-save to `~/.aion/sessions`, resume with `aion --continue` (one-shot `-p` turns included)
- `/export` — conversation → Markdown
- Streaming markdown: answers render formatted while tokens arrive
- Council v2: configurable seats (`cfg.council.seats`), `/council` without argument re-deliberates the last prompt
- Genome v2: per-rule confidence, `/genome pin <n>` makes rules survive dreams and resets
- First-launch animated feature tour
- Unicode-safe input editing (emoji never split)
- Sandboxed test suites via `AION_HOME` env override

## 3.0.0
- OpenCode-style fullscreen TUI, council mode, evolution engine, Aegis failover, triadic memory, dream cycle, neural router
