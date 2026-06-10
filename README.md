<div align="center">

# ◆ AION — the eternal agent

**A terminal AI agent with a real brain: it remembers, dreams, deliberates — and evolves.**

[![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](package.json)
[![node >= 18](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![license MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-0078d4)](#)
[![CI](https://img.shields.io/badge/CI-3%20OS%20%C3%97%203%20node-brightgreen?logo=githubactions&logoColor=white)](.github/workflows/ci.yml)
[![tests](https://img.shields.io/badge/tests-79%20passing-brightgreen)](test/)

*Hermes delivers messages. OpenClaw follows orders.*
***Aion is eternity itself — the agent that doesn't just grow with you, it evolves.***

`📸 [GIF placeholder: fullscreen TUI — streaming markdown answer with thought timer]`

</div>

---

## Install

```cmd
git clone https://github.com/aion-agent/aion && cd aion && npm install -g .
```

Then, from **any** terminal:

```cmd
aion
```

That's the whole install. **Zero npm dependencies** — pure Node.js ≥ 18.
First launch runs a setup wizard: connect **Ollama** (local or Ollama Cloud), optionally add Anthropic, OpenAI, Google, OpenRouter, Groq, xAI or Mistral, pick your models — done. A short animated feature tour shows you around.

---

## Why this isn't just another chat CLI

### 🧬 Evolution Engine
Aion reads your reactions — *"perfekt!"*, *"nein, falsch"* — as feedback signals. During dream cycles it **rewrites its own behavioral genome**: rules injected into every future system prompt, each with a confidence score that grows as rules survive successive dreams.

```text
❯ /genome
 1 ████░  78% Always answer in German unless asked otherwise 📌
 2 ███░░  65% Prefer PowerShell over cmd in examples
 3 ██░░░  50% Keep answers under 10 lines for quick questions
```

Pin a rule (`/genome pin 1`) and it becomes immortal — it survives dreams *and* resets.

### 🏛 Council Mode
`/council <question>` makes **multiple models deliberate in parallel** — an Analyst, a Critic and a Visionary, each on a different model — then a chairperson synthesizes one superior answer. `/council` with no argument re-deliberates your last prompt. Seats are fully configurable in `config.json`:

```jsonc
"council": { "seats": [
  { "role": "Skeptic",  "style": "doubt everything", "model": "ollama:glm-4.6:cloud" },
  { "role": "Engineer", "style": "think in tradeoffs", "model": "anthropic:claude-sonnet-4-6" }
]}
```

`📸 [GIF placeholder: /council — three seats answering in parallel, chairperson synthesis streaming]`

### 💤 Triadic Memory + Dream Cycle
Three memory systems, like a brain: **episodic** (what happened), **semantic** (what is true), **procedural** (how to do things). On exit — or with `/dream` — Aion consolidates: episodes compress into durable facts, duplicates merge, stale memories decay and prune. Recall is hybrid trigram-cosine + keyword scoring: offline, multilingual, instant, no embedding model needed.

### ⚡ Aegis Resilience
Model overloaded? Rate-limited? Network blip? Aion retries with backoff, then **fails over to backup models mid-turn**. An error has never killed a conversation since.

### 🧠 Neural Router
Simple turns route to your fast/local model, hard ones to the flagship — automatically, by analyzing the prompt. Faster *and* cheaper, toggle with `/router`.

### ↻ Sessions that survive
Every conversation auto-saves. `aion --continue` resumes exactly where you left off, `/sessions` opens a picker to jump back into any past conversation — even one-shot `aion -p` calls are resumable. `/export` writes the chat as clean Markdown.

### ⚒ Self-forging skills
Aion writes, saves and reuses its own skills as it works. Successful multi-tool workflows are auto-learned as procedures — no command needed.

---

## Architecture

```text
                    ┌─────────────────────────────────────────────┐
                    │              TUI  (alt-screen, mouse,        │
                    │     streaming markdown, command palette)     │
                    └──────────────────────┬──────────────────────┘
                                           │
        ┌─────────────────┬────────────────┼────────────────┬──────────────────┐
        ▼                 ▼                ▼                ▼                  ▼
 ┌────────────┐   ┌─────────────┐   ┌───────────┐   ┌────────────┐   ┌──────────────┐
 │   Neural   │   │   Council   │   │   Agent   │   │  Sessions  │   │   Evolution  │
 │   Router   │   │  (parallel  │   │   loop    │   │ (~/.aion/  │   │    Engine    │
 │ fast⇄smart │   │ multi-model)│   │ 12 rounds │   │  sessions) │   │  🧬 genome   │
 └─────┬──────┘   └──────┬──────┘   └─────┬─────┘   └────────────┘   └──────┬───────┘
       │                 │                │                                 │
       ▼                 ▼                ▼                                 ▼
 ┌──────────────────────────────────┐  ┌─────────┐               ┌──────────────────┐
 │       Aegis Resilience           │  │  Tools  │               │  Triadic Memory  │
 │  retry → backoff → failover      │  │ shell · │               │ episodic·semantic │
 └───────────────┬──────────────────┘  │ files · │               │   ·procedural    │
                 ▼                     │  web ·  │               │   + Dream Cycle  │
 ┌──────────────────────────────────┐  │ memory ·│               └──────────────────┘
 │  Providers: Ollama (local/cloud) │  │ skills  │
 │  Anthropic·OpenAI·Google·Groq·   │  └─────────┘
 │  OpenRouter·xAI·Mistral          │
 └──────────────────────────────────┘
```

## vs. the field

| | Hermes Agent | OpenClaw | **AION** |
|---|---|---|---|
| Memory | flat curated notes | session files | **triadic** — episodic + semantic + procedural, importance-scored, time-decayed |
| Consolidation | — | — | **Dream Cycle** 💤 — episodes→facts, dedup, prune |
| Self-improvement | — | — | **Evolution Engine** 🧬 — genome rewritten from your feedback, confidence-scored, pinnable |
| Multi-model | one model | one model | **Council** 🏛 — parallel deliberation + synthesis, **Router** — auto fast/smart lane |
| Failure handling | error → dead turn | error → dead turn | **Aegis** ⚡ — retry, backoff, mid-turn failover |
| Skills | install from hub | plugins | **self-forging** + auto-learned procedures |
| Recall | embeddings (needs model) | grep | hybrid trigram+keyword — offline, multilingual, instant |
| Dependencies | dozens | dozens | **zero** |

## The TUI

`📸 [GIF placeholder: command palette (Ctrl+P) and model picker]`

- **Streaming markdown** — answers render formatted *while* they stream, with live thought timers
- **Mouse-native** — wheel scrolls, click the model name to switch brains, click to place the cursor
- **Resize-proof** — the whole frame re-renders from state; emoji-safe input editing
- **Clickable links** — URLs are real hyperlinks (Ctrl+click in Windows Terminal)
- **Multiline input** — `Ctrl+J` or trailing `\` + `↵` for newlines; pasted blocks keep their line breaks
- Keys: `↵` send · `↑↓` history/lines · `Ctrl+P` palette · `PgUp/PgDn` scroll · `Esc` interrupt · `Ctrl+L` clear

## Daily use

```text
❯ merk dir: mein Server heißt atlas und läuft auf Port 8443
  ⚙ remember {"fact":"User's server is named atlas, runs on port 8443"...}
✔ Gemerkt.

❯ /council should I shard this database now or later?
❯ /facts            # what Aion knows about you
❯ /genome           # its evolved rules + confidence
❯ /dream            # consolidate memory right now
❯ /export           # save the conversation as Markdown
❯ /help             # everything else
```

Scripts & pipes:

```cmd
aion -p "summarize my reminders"
aion --continue
```

## Where things live

```text
%USERPROFILE%\.aion\
├── config.json         providers, models, router, council seats
├── memory\
│   ├── episodes.json   what happened
│   ├── facts.json      what is true
│   ├── procedures.json how to do things
│   ├── user.json       who you are
│   └── genome.json     🧬 evolved behavior rules
├── sessions\           resumable conversations
├── skills\             self-forged skills (*.md)
└── reminders.json
```

Everything is local. Nothing leaves your machine except the LLM calls you configure.

## Development

```cmd
npm test        # 79 smoke + TUI-hardening tests, sandboxed (never touches your ~/.aion)
                # CI runs them on Windows, Ubuntu and macOS × node 18/20/22
```

See [CONTRIBUTING.md](CONTRIBUTING.md). The only rule that's sacred: **zero runtime dependencies**.

---

<div align="center">

*"Hermes ran fast. Aion never stops."*

</div>
