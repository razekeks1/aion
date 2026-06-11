# Contributing to AION

Thanks for wanting to make the eternal agent better. A few ground rules keep it eternal:

## The one sacred rule

**Zero runtime dependencies.** No npm packages, ever. Everything is built on Node.js built-ins (`node:fs`, `node:readline`, global `fetch`, …). PRs that add a dependency will be closed, lovingly.

## Getting started

```cmd
git clone https://github.com/razekeks1/aion && cd aion
npm install -g .        # link the `aion` command to your checkout
npm test                # smoke + TUI-hardening suites (sandboxed via AION_HOME)
```

Tests run against an isolated temp directory — they never touch your real `~/.aion` data.

## Project map

| File | What lives there |
|---|---|
| `src/index.mjs` | CLI entry, flags (`-p`, `--continue`, `setup`) |
| `src/repl.mjs` | fullscreen TUI app — rendering, input, slash commands |
| `src/tui.mjs` | raw terminal primitives — key/mouse parsing, ANSI wrapping |
| `src/agent.mjs` | agent loop, Aegis failover, neural router, council |
| `src/memory.mjs` | triadic memory, dream cycle, evolution genome |
| `src/providers.mjs` | Ollama + OpenAI-compatible streaming clients |
| `src/sessions.mjs` | session persistence + Markdown export |
| `src/tools.mjs` | the agent's tools (shell, files, web, memory, skills) |
| `src/setup.mjs` | first-run wizard |

## Pull requests

- Windows is the first-class platform; keep paths and shell calls portable where cheap.
- Add a check to `test/smoke.mjs` (logic) or `test/tui-commands.mjs` (TUI) for anything you fix or add.
- Keep the style: small modules, no classes where a function does, comments explain *why*.
- One feature per PR. Bump the version per semver in `package.json`.

## Reporting bugs

Open an issue with your terminal (Windows Terminal? ConHost?), Node version, and the smallest reproduction you can manage. TUI rendering bugs: include the window size if you can.
