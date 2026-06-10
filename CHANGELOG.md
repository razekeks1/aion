# Changelog

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
