// AION — fullscreen TUI, OpenCode-style. Alt screen, mouse, resize-proof.
// Empty state: centered logo + centered input. Chat: user blocks with accent
// bar, thought timers, per-answer meta line, bottom status bar, ctrl+p palette.
import os from "node:os";
import { Term, wrapAnsi, padTrunc, visLen, stripAnsi } from "./tui.mjs";
import { runTurn, runCouncil, summarizeTurn } from "./agent.mjs";
import { Memory, detectFeedback } from "./memory.mjs";
import { loadSkills, dueReminders } from "./tools.mjs";
import { saveConfig } from "./config.mjs";
import { runSetup, collectModels } from "./setup.mjs";
import { PROVIDERS, quickChat } from "./providers.mjs";
import { newSessionId, saveSession, exportMarkdown, listSessions } from "./sessions.mjs";
import path from "node:path";
import fs from "node:fs";
import {
  violet, aqua, ok, warn, err, dim, bold, gradient, renderMarkdown,
  createInterface, Spinner, c,
} from "./ui.mjs";

const BG = "\x1b[48;5;234m";
const fg = (n) => `\x1b[38;5;${n}m`;
const RESET = "\x1b[0m";
const amber = (s) => `\x1b[38;5;214m${s}\x1b[0m`;

const LOGO = [
  " █████╗ ██╗ ██████╗ ███╗   ██╗",
  "██╔══██╗██║██╔═══██╗████╗  ██║",
  "███████║██║██║   ██║██╔██╗ ██║",
  "██╔══██║██║██║   ██║██║╚██╗██║",
  "██║  ██║██║╚██████╔╝██║ ╚████║",
  "╚═╝  ╚═╝╚═╝ ╚═════╝ ╚═╝  ╚═══╝",
];

const TIPS = [
  "/council lets multiple models deliberate your question in parallel",
  "Aion evolves a genome from your feedback — see it with /genome",
  "/dream consolidates memory into durable facts",
  "click the model name below the input to switch brains",
  "Aion can forge its own skills — ask it to automate a workflow",
  "hold Shift to select & copy text",
  "/router sends easy questions to a faster model",
  'aion -p "…" works in scripts and pipes',
  "/facts shows everything Aion remembers about you",
];

const PALETTE = [
  ["council", "multi-model deliberation on a question", true],
  ["goal", "autonomous mode — work in a loop until the goal is done", true],
  ["loop", "repeat a prompt on an interval (or self-paced)", true],
  ["export", "save conversation as Markdown", false],
  ["sessions", "browse & resume past conversations", false],
  ["genome", "show evolved rules with confidence", false],
  ["model", "switch main model", false],
  ["models", "list available models", false],
  ["router", "toggle neural router", false],
  ["memory", "memory overview", false],
  ["facts", "list remembered facts", false],
  ["remember", "save a fact to memory", true],
  ["forget", "delete matching memories", true],
  ["dream", "consolidate memory now", false],
  ["skills", "list forged skills", false],
  ["persona", "reshape Aion's persona", true],
  ["stats", "session statistics", false],
  ["setup", "run the setup wizard", false],
  ["clear", "clear conversation", false],
  ["reset", "wipe all memory", false],
  ["help", "show help", false],
  ["exit", "quit aion", false],
];

const fmtDur = (ms) => (ms < 1000 ? `${Math.max(0, Math.round(ms))}ms` : `${(ms / 1000).toFixed(1)}s`);

// code-point-aware cursor steps so emoji/astral chars never split surrogate pairs
export const cpPrev = (t, i) => (i >= 2 && (t.codePointAt(i - 2) ?? 0) >= 0x10000 ? i - 2 : Math.max(0, i - 1));
export const cpNext = (t, i) => (i < t.length && (t.codePointAt(i) ?? 0) >= 0x10000 ? i + 2 : Math.min(t.length, i + 1));

// "5m" → 300000ms · supports s/m/h/d · null if not an interval token
export function parseInterval(tok) {
  const m = /^(\d+)([smhd])$/.exec(tok || "");
  if (!m) return null;
  return +m[1] * { s: 1000, m: 60000, h: 3600000, d: 86400000 }[m[2]];
}

const fmtMs = (ms) => {
  if (ms < 60000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
  return `${(ms / 3600000).toFixed(ms % 3600000 ? 1 : 0)}h`;
};

export async function runRepl(cfg, version, resume = null) {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    console.error('Interactive mode needs a terminal. Use: aion -p "your prompt"');
    process.exit(1);
  }
  const app = new App(cfg, version, resume);
  await app.run();
}

export class App {
  constructor(cfg, version, resume = null) {
    this.cfg = cfg;
    this.version = version;
    this.term = new Term();
    this.memory = new Memory();
    this.history = [];
    this.msgs = [];                 // {kind:'user'|'ai'|'tool'|'sys'|'thought'|'meta', text, done}
    this.scroll = 0;
    this.input = { text: "", cur: 0, hist: [], hi: -1, draft: "" };
    this.busy = false;
    this.status = "";
    this.abort = null;
    this.overlay = null;
    this.capture = null;
    this.dirty = true;
    this.quitting = false;
    this._wrap = new Map();
    this._hscroll = 0;
    this._inputPos = null;          // {y, textX}
    this._modelZone = null;         // {y, x1, x2}
    this._lastModel = null;
    this._tip = TIPS[Math.floor(Math.random() * TIPS.length)];
    this.goal = null;       // {text, iter, max, resumeAt}
    this.autoLoop = null;   // {prompt, intervalMs|null (self-paced), runs, nextAt}
    this.sessionId = resume?.id || newSessionId();
    if (resume?.history?.length) {
      this.history = resume.history.slice(-40);
      for (const m of this.history) {
        if (m.role === "user") this.add("user", String(m.content));
        else if (m.role === "assistant") { const a = this.add("ai", renderMarkdown(String(m.content))); a.done = true; }
      }
      this.add("sys", dim(`↻ resumed session · ${resume.turns || "?"} turns · ${new Date(resume.updated).toLocaleString()}`));
    }
  }

  saveSession() {
    try {
      saveSession(this.sessionId, this.history, { model: this.cfg.model.id });
    } catch {}
  }

  // ── lifecycle ──────────────────────────────────────────
  async run() {
    this.term.onResize = () => { this.dirty = true; };
    this.term.onEvent = (ev) => this.onEvent(ev);
    this.term.enter();

    const { due, pending } = dueReminders();
    for (const r of due) this.add("sys", warn(`⏰ ${r.text}`) + dim(` (due ${r.when})`));

    this.timer = setInterval(() => {
      if (this.dirty || this.busy) { this.render(); this.dirty = false; }
      this.tickAutomations();
    }, 33);
    this.render();
    if (this.cfg.tourPending) this.runTour();
    return new Promise(() => {});
  }

  // ── /goal & /loop engine ───────────────────────────────
  // Fires pending goal iterations and due loop runs whenever the app is idle.
  tickAutomations() {
    if (this.busy || this.overlay || this.capture || this.quitting) return;
    if (this.goal?.resumeAt && Date.now() >= this.goal.resumeAt) {
      this.goal.resumeAt = 0;
      this.goalStep();
      return;
    }
    if (this.autoLoop && Date.now() >= this.autoLoop.nextAt) {
      this.autoLoop.nextAt = Infinity; // re-armed by loopStep when the run ends
      this.loopStep();
    } else if (this.autoLoop && this.autoLoop.nextAt !== Infinity) {
      // keep the countdown in the status bar ticking
      const left = this.autoLoop.nextAt - Date.now();
      if (Math.floor(left / 1000) !== this.autoLoop._lastLeft) {
        this.autoLoop._lastLeft = Math.floor(left / 1000);
        this.dirty = true;
      }
    }
  }

  async goalStep() {
    const G = this.goal;
    if (!G) return;
    G.iter++;
    const directive = G.iter === 1
      ? `GOAL MODE — work autonomously toward this goal:\n${G.text}\n\nUse your tools, make decisions yourself, verify your own work. End your answer with a short status. When — and only when — the goal is fully achieved AND verified, include the literal token GOAL_COMPLETE.`
      : `GOAL MODE iteration ${G.iter}/${G.max} — the goal: ${G.text}\nContinue from where you left off. Verify results with tools. Include GOAL_COMPLETE only when fully done; otherwise state your next concrete step.`;
    const before = this.history.length;
    await this.turn(directive, `🎯 goal ${G.iter}/${G.max} — ${G.text.slice(0, 70)}`);
    if (!this.goal) return; // cleared meanwhile
    if (this.history.length === before) {
      this.add("sys", warn("🎯 goal paused — the turn was interrupted or produced nothing. ") + dim("/goal resume to retry · /goal clear to drop"));
      G.resumeAt = 0;
      return;
    }
    const lastA = [...this.history].reverse().find((m) => m.role === "assistant");
    if (/GOAL_COMPLETE/.test(String(lastA?.content || ""))) {
      this.add("sys", ok(`🎯 goal complete after ${G.iter} iteration${G.iter > 1 ? "s" : ""}`));
      this.goal = null;
    } else if (G.iter >= G.max) {
      this.add("sys", warn(`🎯 stopped at the ${G.max}-iteration safety limit`) + dim(" — /goal resume continues, /goal clear drops it"));
      G.resumeAt = 0;
    } else {
      G.resumeAt = Date.now() + 1500;
      this.add("sys", dim(`🎯 not done yet — iteration ${G.iter + 1} starts in a moment (Esc + /goal clear to stop)`));
    }
    this.dirty = true;
  }

  async loopStep() {
    const L = this.autoLoop;
    if (!L) return;
    L.runs++;
    this.add("sys", violet("⟳ ") + dim(`loop run #${L.runs} — `) + L.prompt.slice(0, 70));
    if (L.prompt.startsWith("/")) await this.command(L.prompt);
    else await this.turn(L.prompt);
    if (!this.autoLoop) return; // stopped meanwhile
    let delay = L.intervalMs;
    if (!delay) {
      // self-paced: a quick model call picks the next sensible delay
      delay = 600000;
      try {
        const lastA = [...this.history].reverse().find((m) => m.role === "assistant");
        const m = this.cfg.fastModel?.id ? this.cfg.fastModel : this.cfg.model;
        const out = await quickChat(this.cfg, {
          provider: m.provider, model: m.id,
          system: "Reply with ONLY a number of seconds between 60 and 3600. Nothing else.",
          prompt: `A recurring task runs in a loop: "${L.prompt}". Latest result: ${String(lastA?.content || "(none)").slice(0, 300)}\nHow many seconds until the next run makes sense?`,
        });
        const n = parseInt(out.match(/\d+/)?.[0], 10);
        if (n >= 60 && n <= 3600) delay = n * 1000;
      } catch {}
      this.add("sys", dim(`⟳ self-paced — next run in ${fmtMs(delay)}`));
    }
    L.nextAt = Date.now() + delay;
    this.dirty = true;
  }

  // first-launch feature tour — short, animated, skippable by just typing
  async runTour() {
    this.cfg.tourPending = false;
    try { saveConfig(this.cfg); } catch {}
    const steps = [
      gradient("✦ Welcome to AION — the eternal agent ✦"),
      `${violet("🧠")} ${bold("Triadic memory")} ${dim("— it remembers facts, episodes & workflows across sessions. Try:")} ${aqua("/facts")}`,
      `${violet("💤")} ${bold("Dream cycle")} ${dim("— sleep consolidates conversations into durable knowledge:")} ${aqua("/dream")}`,
      `${violet("🧬")} ${bold("Evolution engine")} ${dim("— your feedback rewrites its behavioral genome:")} ${aqua("/genome")}`,
      `${violet("🏛")} ${bold("Council mode")} ${dim("— multiple models deliberate in parallel:")} ${aqua("/council <question>")}`,
      `${violet("⚡")} ${bold("Aegis failover")} ${dim("— overloaded models retry & fail over mid-turn. Errors never kill a chat.")}`,
      `${violet("↻")} ${bold("Sessions")} ${dim("— everything is saved. Resume anytime with")} ${aqua("aion --continue")}`,
      dim("…that's the tour. Ask me anything — I'm already learning."),
    ];
    for (const s of steps) {
      if (this.msgs.some((m) => m.kind === "user")) return; // user started typing — stop the show
      this.add("sys", s);
      await new Promise((r) => setTimeout(r, 650));
    }
  }

  async quit() {
    if (this.quitting) return;
    this.quitting = true;
    clearInterval(this.timer);
    this.abort?.abort();
    this.term.exit();
    if (this.cfg.memory?.dreamOnExit && this.memory.newEpisodesSinceDream >= 3 && this.cfg.model.id) {
      const sp = new Spinner("💤 dreaming — consolidating memory…").start();
      try {
        const r = await this.memory.dream(this.cfg, this.cfg.fastModel?.id ? this.cfg.fastModel : this.cfg.model, {});
        sp.stop(`  ${violet("💤")} ${dim(`dreamed: +${r.extracted} facts, ${r.mergedCount} merged, ${r.pruned} pruned`)}`);
      } catch { sp.stop(); }
    }
    this.memory.persist();
    console.log(dim("\n  until next time. aion remembers.\n"));
    process.exit(0);
  }

  add(kind, text) {
    const m = { kind, text, done: true };
    this.msgs.push(m);
    this.dirty = true;
    return m;
  }

  // ── events ─────────────────────────────────────────────
  onEvent(ev) {
    if (this.quitting) return;
    if (this.overlay) return this.overlayEvent(ev);

    if (ev.type === "char") return this.insert(ev.ch);
    if (ev.type === "paste") return this.insert(ev.text); // multiline paste stays multiline

    if (ev.type === "mouse") {
      if (ev.kind === "wheel-up") { this.scroll += 3; this.dirty = true; return; }
      if (ev.kind === "wheel-down") { this.scroll = Math.max(0, this.scroll - 3); this.dirty = true; return; }
      if (ev.kind === "click") return this.click(ev.x, ev.y);
      return;
    }

    if (ev.type !== "key") return;
    const I = this.input;
    switch (ev.name) {
      case "enter":
        // trailing backslash continues on the next line (claude-code idiom)
        if (I.text.endsWith("\\") && I.cur === I.text.length) {
          I.text = I.text.slice(0, -1) + "\n"; I.cur = I.text.length; this.dirty = true; return;
        }
        return this.submit();
      case "ctrl-j": return this.insert("\n");
      case "ctrl-p": return this.openPalette();
      case "backspace":
        if (I.cur > 0) { const p = cpPrev(I.text, I.cur); I.text = I.text.slice(0, p) + I.text.slice(I.cur); I.cur = p; this.dirty = true; }
        return;
      case "delete":
        if (I.cur < I.text.length) { I.text = I.text.slice(0, I.cur) + I.text.slice(cpNext(I.text, I.cur)); this.dirty = true; }
        return;
      case "left": I.cur = ev.ctrl ? this.wordLeft() : cpPrev(I.text, I.cur); this.dirty = true; return;
      case "right": I.cur = ev.ctrl ? this.wordRight() : cpNext(I.text, I.cur); this.dirty = true; return;
      case "home": I.cur = I.text.lastIndexOf("\n", I.cur - 1) + 1; this.dirty = true; return;
      case "end": { const nl = I.text.indexOf("\n", I.cur); I.cur = nl === -1 ? I.text.length : nl; this.dirty = true; return; }
      case "ctrl-u": I.text = ""; I.cur = 0; this.dirty = true; return;
      case "ctrl-w": {
        const left = this.wordLeft();
        I.text = I.text.slice(0, left) + I.text.slice(I.cur);
        I.cur = left; this.dirty = true; return;
      }
      case "ctrl-l": this.msgs = []; this._wrap.clear(); this.scroll = 0; this.dirty = true; return;
      case "up": return this.lineNav(-1) || this.histNav(-1);
      case "down": return this.lineNav(1) || this.histNav(1);
      case "pgup": this.scroll += this.viewH() - 1; this.dirty = true; return;
      case "pgdn": this.scroll = Math.max(0, this.scroll - this.viewH() + 1); this.dirty = true; return;
      case "esc":
        if (this.capture) { const r = this.capture.resolve; this.capture = null; this.dirty = true; r(null); return; }
        if (this.busy && this.abort) { this.abort.abort(); return; }
        this.scroll = 0; this.dirty = true;
        return;
      case "ctrl-c":
        if (this.busy && this.abort) { this.abort.abort(); return; }
        if (I.text) { I.text = ""; I.cur = 0; this.dirty = true; return; }
        this.quit();
        return;
    }
  }

  insert(s) {
    const I = this.input;
    I.text = I.text.slice(0, I.cur) + s + I.text.slice(I.cur);
    I.cur += s.length;
    I.hi = -1;
    this.dirty = true;
  }

  wordLeft() {
    const t = this.input.text; let i = this.input.cur;
    while (i > 0 && t[i - 1] === " ") i--;
    while (i > 0 && t[i - 1] !== " ") i--;
    return i;
  }
  wordRight() {
    const t = this.input.text; let i = this.input.cur;
    while (i < t.length && t[i] !== " ") i++;
    while (i < t.length && t[i] === " ") i++;
    return i;
  }

  // move the cursor between input lines; returns true if it moved
  lineNav(dir) {
    const I = this.input;
    if (!I.text.includes("\n")) return false;
    const start = I.text.lastIndexOf("\n", I.cur - 1) + 1;
    const col = I.cur - start;
    if (dir === -1) {
      if (start === 0) return false;
      const prevStart = I.text.lastIndexOf("\n", start - 2) + 1;
      I.cur = Math.min(prevStart + col, start - 1);
    } else {
      const end = I.text.indexOf("\n", I.cur);
      if (end === -1) return false;
      const nextEnd = I.text.indexOf("\n", end + 1);
      I.cur = Math.min(end + 1 + col, nextEnd === -1 ? I.text.length : nextEnd);
    }
    this.dirty = true;
    return true;
  }

  histNav(dir) {
    const I = this.input;
    if (!I.hist.length) return;
    if (I.hi === -1 && dir === -1) { I.draft = I.text; I.hi = I.hist.length - 1; }
    else if (I.hi !== -1) {
      I.hi += dir;
      if (I.hi >= I.hist.length) { I.hi = -1; I.text = I.draft; I.cur = I.text.length; this.dirty = true; return; }
      if (I.hi < 0) I.hi = 0;
    } else return;
    I.text = I.hist[I.hi];
    I.cur = I.text.length;
    this.dirty = true;
  }

  click(x, y) {
    if (this._modelZone && y === this._modelZone.y && x >= this._modelZone.x1 && x <= this._modelZone.x2) {
      if (!this.busy) this.command("/model");
      return;
    }
    if (this._inputPos && y >= this._inputPos.y && y < this._inputPos.y + (this._inputPos.h || 1)) {
      const I = this.input;
      const lines = I.text.split("\n");
      const li = Math.min(lines.length - 1, (this._vscroll || 0) + (y - this._inputPos.y));
      let off = 0;
      for (let i = 0; i < li; i++) off += lines[i].length + 1;
      const col = Math.max(0, (x - this._inputPos.textX) + (li === 0 || lines.length === 1 ? this._hscroll : 0));
      I.cur = Math.min(off + Math.min(col, lines[li].length), I.text.length);
      this.dirty = true;
    }
  }

  openPalette() {
    if (this.overlay) return;
    const items = PALETTE.map(([name, desc, needsArg]) => ({
      label: violet("/" + name), hint: desc, value: name + (needsArg ? "\x01" : ""),
    }));
    this.pick("Commands", items).then((v) => {
      if (!v) return;
      if (v.endsWith("\x01")) {
        this.input.text = "/" + v.slice(0, -1) + " ";
        this.input.cur = this.input.text.length;
        this.dirty = true;
      } else {
        this.command("/" + v);
      }
    });
  }

  // ── overlay picker ─────────────────────────────────────
  pick(title, items) {
    return new Promise((resolve) => {
      this.overlay = { title, items, sel: 0, top: 0, resolve, box: null };
      this.dirty = true;
    });
  }

  closeOverlay(value) {
    const r = this.overlay?.resolve;
    this.overlay = null;
    this.dirty = true;
    r?.(value);
  }

  overlayEvent(ev) {
    const O = this.overlay;
    const page = O.box ? O.box.h - 2 : 10;
    if (ev.type === "key") {
      if (ev.name === "esc" || ev.name === "ctrl-c") return this.closeOverlay(null);
      if (ev.name === "enter") return this.closeOverlay(O.items[O.sel]?.value ?? null);
      if (ev.name === "up") O.sel = Math.max(0, O.sel - 1);
      if (ev.name === "down") O.sel = Math.min(O.items.length - 1, O.sel + 1);
      if (ev.name === "pgup") O.sel = Math.max(0, O.sel - page);
      if (ev.name === "pgdn") O.sel = Math.min(O.items.length - 1, O.sel + page);
      if (ev.name === "home") O.sel = 0;
      if (ev.name === "end") O.sel = O.items.length - 1;
    }
    if (ev.type === "mouse") {
      if (ev.kind === "wheel-up") O.sel = Math.max(0, O.sel - 2);
      if (ev.kind === "wheel-down") O.sel = Math.min(O.items.length - 1, O.sel + 2);
      if (ev.kind === "click" && O.box) {
        const { x, y, w, h } = O.box;
        if (ev.y > y && ev.y < y + h - 1 && ev.x > x && ev.x < x + w) {
          const idx = O.top + (ev.y - y - 1);
          if (idx >= 0 && idx < O.items.length) { O.sel = idx; return this.closeOverlay(O.items[idx].value); }
        } else if (ev.y < y || ev.y >= y + h || ev.x <= x || ev.x > x + w) {
          return this.closeOverlay(null);
        }
      }
    }
    this.dirty = true;
  }

  promptInput(label) {
    return new Promise((resolve) => {
      this.capture = { label, resolve };
      this.input.text = ""; this.input.cur = 0;
      this.dirty = true;
    });
  }

  // ── submit ─────────────────────────────────────────────
  async submit() {
    const line = this.input.text.trim();
    if (this.capture) {
      const r = this.capture.resolve;
      this.capture = null;
      this.input.text = ""; this.input.cur = 0;
      this.dirty = true;
      r(line || null);
      return;
    }
    if (!line || this.busy) return;
    this.input.hist.push(line);
    this.input.text = ""; this.input.cur = 0; this.input.hi = -1;
    this.scroll = 0;
    if (line.startsWith("/")) await this.command(line);
    else await this.turn(line);
  }

  // ── chat turn ──────────────────────────────────────────
  async turn(line, display = null) {
    // implicit feedback about the previous answer feeds the Evolution Engine
    const fb = detectFeedback(line);
    if (fb && this.history.length >= 2) {
      const lastA = this.history[this.history.length - 1];
      this.memory.recordFeedback(fb, `assistant: ${String(lastA.content).slice(0, 140)} | user: ${line.slice(0, 90)}`);
    }

    this.add("user", display || line);
    this.busy = true;
    this.status = "thinking";
    this.abort = new AbortController();
    let sm = { kind: "ai", text: "", done: false };
    this.msgs.push(sm);
    const t0 = Date.now();
    let thinkT0 = 0, thought = null;
    const toolPending = [];
    const toolTrace = [];

    try {
      const { content, model, usage } = await runTurn(this.cfg, this.memory, this.history, line, (ev) => {
        if (ev.type === "route") {
          this._lastModel = ev.model;
          if (ev.model.tier === "fast") this.status = "thinking " + dim("(fast lane)");
        }
        if (ev.type === "retry") {
          this.add("sys", amber("⚡ ") + dim(`${ev.model} struggling — retry ${ev.attempt} in ${fmtDur(ev.delay)}`));
          this.status = "retrying";
        }
        if (ev.type === "failover") {
          this.add("sys", amber("⚡ failover ") + dim(ev.from + " → ") + aqua(ev.to));
          this._lastModel = { id: ev.to };
          this.status = "failover";
        }
        if (ev.type === "thinking") {
          const now = Date.now();
          if (!thinkT0) {
            thinkT0 = now;
            thought = { kind: "thought", text: "" };
            this.msgs.splice(this.msgs.indexOf(sm), 0, thought);
          }
          thought.text = amber("✦ Thought: " + fmtDur(now - thinkT0));
          this.status = "reasoning " + dim(fmtDur(now - thinkT0));
        }
        if (ev.type === "token") { sm.text += ev.token; this.status = "writing"; }
        if (ev.type === "tool-start") {
          if (sm.text.trim()) { sm.done = true; sm.text = renderMarkdown(sm.text); }
          else this.msgs.splice(this.msgs.indexOf(sm), 1);
          const args = JSON.stringify(ev.args || {});
          const tm = this.add("tool", dim("⚙ ") + aqua(ev.name) + dim(" " + (args.length > 64 ? args.slice(0, 64) + "…" : args)));
          toolPending.push(tm);
          toolTrace.push(ev.name);
          this.status = "running " + ev.name;
          sm = { kind: "ai", text: "", done: false };
          this.msgs.push(sm);
        }
        if (ev.type === "tool-end") {
          const tm = toolPending.shift();
          if (tm) { tm.text += " " + ok("✓"); this._wrap.delete(tm); }
          this.status = "thinking";
        }
        this.dirty = true;
      }, this.abort.signal);

      if (content?.trim()) {
        sm.text = renderMarkdown(content);
        sm.done = true;
        const modelId = model?.id || this._lastModel?.id || this.cfg.model.id;
        const tok = usage ? ` · ${usage.out} tok${usage.tps ? ` · ${usage.tps} tok/s` : ""}` : "";
        this.add("meta", dim(`◆ ${modelId} · ${fmtDur(Date.now() - t0)}${tok}`));
        this.history.push({ role: "user", content: line });
        this.history.push({ role: "assistant", content });
        if (this.history.length > 40) this.history.splice(0, this.history.length - 30);
        this.saveSession();
        this.memory.addEpisode(summarizeTurn(line, content));
        // auto-learn the workflow as a procedure — no explicit forge needed
        if (toolTrace.length >= 2) {
          this.memory.addProcedure(`auto: ${line.slice(0, 50)}`, `${toolTrace.join(" → ")} — for: ${line.slice(0, 120)}`);
        }
        this.memory.persist();
      } else {
        this.msgs.splice(this.msgs.indexOf(sm), 1);
        this.add("sys", dim("(no response — try again or /model to switch)"));
      }
    } catch (e) {
      if (!sm.done && !sm.text.trim()) {
        const i = this.msgs.indexOf(sm);
        if (i !== -1) this.msgs.splice(i, 1);
      }
      if (e?.name === "AbortError") this.add("sys", dim("✋ interrupted"));
      else this.add("sys", err("✖ ") + e.message);
    } finally {
      this.busy = false;
      this.status = "";
      this.abort = null;
      this.dirty = true;
    }
  }

  // ── council turn ───────────────────────────────────────
  async councilTurn(question) {
    this.add("user", question);
    this.busy = true;
    this.status = "convening council";
    this.abort = new AbortController();
    const t0 = Date.now();
    let sm = null;
    let thinkT0 = 0, thought = null;

    try {
      const { content, seats, model } = await runCouncil(this.cfg, this.memory, this.history, question, (ev) => {
        if (ev.type === "council-start") {
          this.add("sys", violet("🏛 council convened — ") + dim(ev.seats.map((s) => `${s.role}: ${s.model.id}`).join(" · ")));
          this.status = "council deliberating";
        }
        if (ev.type === "council-answer") {
          this.add("tool", dim("🏛 ") + aqua(ev.seat) + dim(` (${ev.model}) `) + ok("✓") + dim(" " + fmtDur(ev.ms)));
        }
        if (ev.type === "council-fail") {
          this.add("tool", dim("🏛 ") + aqua(ev.seat) + " " + err("✖ ") + dim(String(ev.error).slice(0, 60)));
        }
        if (ev.type === "council-synthesize") this.status = "synthesizing";
        if (ev.type === "retry") this.status = "retrying";
        if (ev.type === "failover") this.add("sys", amber("⚡ failover ") + dim(ev.from + " → ") + aqua(ev.to));
        if (ev.type === "thinking") {
          const now = Date.now();
          if (!thinkT0) {
            thinkT0 = now;
            thought = { kind: "thought", text: "" };
            this.msgs.push(thought);
          }
          thought.text = amber("✦ Thought: " + fmtDur(now - thinkT0));
        }
        if (ev.type === "token") {
          if (!sm) { sm = { kind: "ai", text: "", done: false }; this.msgs.push(sm); }
          sm.text += ev.token;
          this.status = "writing";
        }
        this.dirty = true;
      }, this.abort.signal);

      if (content?.trim()) {
        if (!sm) { sm = { kind: "ai", text: "", done: false }; this.msgs.push(sm); }
        sm.text = renderMarkdown(content);
        sm.done = true;
        this.add("meta", dim(`◆ 🏛 council ×${seats} · ${model?.id || this.cfg.model.id} · ${fmtDur(Date.now() - t0)}`));
        this.history.push({ role: "user", content: question });
        this.history.push({ role: "assistant", content });
        this.saveSession();
        this.memory.addEpisode(summarizeTurn(question, content));
        this.memory.persist();
      }
    } catch (e) {
      if (e?.name === "AbortError") this.add("sys", dim("✋ interrupted"));
      else this.add("sys", err("✖ council: ") + e.message);
    } finally {
      this.busy = false;
      this.status = "";
      this.abort = null;
      this.dirty = true;
    }
  }

  // ── slash commands ─────────────────────────────────────
  async command(line) {
    const [cmd, ...rest] = line.slice(1).split(/\s+/);
    const arg = rest.join(" ");
    const sys = (t) => this.add("sys", t);

    switch (cmd) {
      case "help":
        sys(renderMarkdown([
          "**Chat** — type & ↵ · `Esc` stop generation · `Ctrl+C` clear input / quit · `Ctrl+P` command palette",
          "**Council** — `/council <question>` — parallel multi-model deliberation (no arg = redo last prompt)",
          "**Autonomy** — `/goal <mission>` works in a loop until verified done · `/loop [10m] <prompt>` repeats it",
          "**Evolution** — Aion learns from your reactions; `/genome` shows rules + confidence · `/genome pin <n>`",
          "**Sessions** — auto-saved · `/sessions` browse & resume · `aion --continue` · `/export` → Markdown",
          "**Scroll** — mouse wheel · `PgUp`/`PgDn` · `Esc` jump to bottom",
          "**Input** — `↑↓` history/lines · `Ctrl+J` or `\\`+`↵` newline · `Ctrl+←→` word jump · `Ctrl+U` clear · click to place cursor",
          "**Models** — `/model` picker (or click the model name below) · `/models` · `/router`",
          "**Memory** — `/memory` · `/facts` · `/remember <fact>` · `/forget <text>` · `/dream`",
          "**More** — `/skills` · `/persona <text>` · `/setup` · `/clear` · `/reset` · `/exit`",
        ].join("\n")));
        break;

      case "council": {
        // /council with no question re-deliberates the last user prompt
        const q = arg || [...this.history].reverse().find((m) => m.role === "user")?.content;
        if (!q) { sys(dim("usage: /council <question> — parallel multi-model deliberation (no arg = last prompt)")); break; }
        if (!arg) sys(dim("🏛 re-deliberating: ") + String(q).slice(0, 80));
        await this.councilTurn(String(q));
        break;
      }

      case "goal": {
        if (!arg) {
          sys(this.goal
            ? `${violet("🎯")} ${this.goal.text}\n` + dim(`   iteration ${this.goal.iter}/${this.goal.max} · /goal clear to stop · /goal resume to continue a paused goal`)
            : dim("usage: /goal <mission> — Aion works autonomously in a loop until it verifies the goal is done\n       /goal clear · /goal resume · /goal max <n>"));
          break;
        }
        if (arg === "clear") {
          sys(this.goal ? `${ok("✔")} goal cleared` : dim("no active goal"));
          this.goal = null;
          break;
        }
        if (arg === "resume") {
          if (!this.goal) { sys(dim("no goal to resume")); break; }
          if (this.goal.iter >= this.goal.max) this.goal.max += 10;
          sys(dim("🎯 resuming…"));
          await this.goalStep();
          break;
        }
        const maxM = arg.match(/^max\s+(\d+)$/);
        if (maxM) {
          if (!this.goal) { sys(dim("no active goal")); break; }
          this.goal.max = Math.max(this.goal.iter, parseInt(maxM[1], 10));
          sys(`${ok("✔")} iteration limit → ${this.goal.max}`);
          break;
        }
        this.goal = { text: arg, iter: 0, max: 15, resumeAt: 0 };
        sys(`${violet("🎯 goal set")} ${dim("— working autonomously, max 15 iterations · Esc interrupts · /goal clear stops")}`);
        await this.goalStep();
        break;
      }

      case "loop": {
        if (!arg || arg === "status") {
          sys(this.autoLoop
            ? `${violet("⟳")} "${this.autoLoop.prompt.slice(0, 60)}" · ${this.autoLoop.runs} runs · ` +
              (this.autoLoop.intervalMs ? `every ${fmtMs(this.autoLoop.intervalMs)}` : "self-paced") +
              (this.autoLoop.nextAt !== Infinity ? dim(` · next in ${fmtMs(Math.max(0, this.autoLoop.nextAt - Date.now()))}`) : dim(" · running")) +
              dim(" · /loop stop")
            : dim("usage: /loop <interval> <prompt> — repeat a prompt (e.g. /loop 10m check my reminders)\n       /loop <prompt> — self-paced: Aion picks the next run time itself\n       /loop stop · /loop status"));
          break;
        }
        if (arg === "stop") {
          sys(this.autoLoop ? `${ok("✔")} loop stopped after ${this.autoLoop.runs} runs` : dim("no active loop"));
          this.autoLoop = null;
          break;
        }
        const [tok, ...restP] = arg.split(/\s+/);
        const iv = parseInterval(tok);
        const prompt = iv ? restP.join(" ") : arg;
        if (!prompt) { sys(dim("usage: /loop [interval] <prompt>")); break; }
        if (/^\/(loop|goal)\b/.test(prompt)) { sys(err("✖ /loop can't recurse into /loop or /goal")); break; }
        if (iv && iv < 30000) { sys(err("✖ minimum interval is 30s")); break; }
        this.autoLoop = { prompt, intervalMs: iv, runs: 0, nextAt: Date.now() };
        sys(`${violet("⟳ loop armed")} ${dim(`— ${iv ? "every " + fmtMs(iv) : "self-paced"} · first run starts now · /loop stop to cancel`)}`);
        break;
      }

      case "export": {
        if (!this.history.length) { sys(dim("nothing to export yet")); break; }
        const file = arg || path.join(process.cwd(), `aion-chat-${this.sessionId}.md`);
        try {
          fs.writeFileSync(file, exportMarkdown(this.history, { agentName: this.cfg.agent.name, model: this.cfg.model.id }), "utf8");
          sys(`${ok("✔")} exported ${this.history.filter((m) => m.role === "user").length} turns → ${aqua(file)}`);
        } catch (e) { sys(err("✖ export failed: ") + e.message); }
        break;
      }

      case "sessions": {
        const all = listSessions();
        if (!all.length) { sys(dim("no saved sessions yet")); break; }
        const fmtAge = (ts) => {
          const m = Math.round((Date.now() - ts) / 60000);
          return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
        };
        const items = all.slice(0, 20).map((s) => ({
          label: (s.id === this.sessionId ? ok("● ") : "  ") + s.title.slice(0, 48),
          hint: `${s.turns} turns · ${fmtAge(s.updated)}`,
          value: s.id,
        }));
        const picked = await this.pick("Resume session", items);
        if (!picked || picked === this.sessionId) break;
        const sess = all.find((s) => s.id === picked);
        if (!sess) break;
        this.sessionId = sess.id;
        this.history = sess.history.slice(-40);
        this.msgs = []; this._wrap.clear(); this.scroll = 0;
        for (const m of this.history) {
          if (m.role === "user") this.add("user", String(m.content));
          else if (m.role === "assistant") this.add("ai", renderMarkdown(String(m.content)));
        }
        sys(dim(`↻ resumed "${sess.title.slice(0, 50)}" · ${sess.turns} turns`));
        break;
      }

      case "genome": {
        const g = this.memory.genome;
        if (arg === "reset") {
          g.rules = g.rules.filter((r) => r.pinned); // pinned rules survive reset
          g.feedback = [];
          this.memory.persist();
          sys(`${ok("✔")} genome reset${g.rules.length ? dim(` (${g.rules.length} pinned rules kept)`) : ""}`);
          break;
        }
        const pinMatch = arg.match(/^(pin|unpin)\s+(\d+)$/);
        if (pinMatch) {
          const idx = parseInt(pinMatch[2], 10) - 1;
          const rule = g.rules[idx];
          if (!rule) { sys(err(`✖ no rule #${idx + 1}`)); break; }
          rule.pinned = pinMatch[1] === "pin";
          this.memory.persist();
          sys(`${ok("✔")} rule #${idx + 1} ${rule.pinned ? "pinned 📌 (survives dreams & resets)" : "unpinned"}`);
          break;
        }
        if (!g.rules.length) {
          sys(dim(`no evolved rules yet — they emerge in /dream from your feedback (${g.feedback.length} signals collected)`));
        } else {
          sys(g.rules.map((r, i) => {
            const conf = r.confidence ?? 0.5;
            const bar = "█".repeat(Math.round(conf * 5)).padEnd(5, "░");
            return `${dim(String(i + 1).padStart(2))} ${violet(bar)} ${dim((conf * 100).toFixed(0).padStart(3) + "%")} ${r.text}${r.pinned ? " 📌" : ""}`;
          }).join("\n") +
            "\n" + dim(`${g.feedback.length} feedback signals pending · /genome pin <n> · /genome reset`));
        }
        break;
      }

      case "model": {
        if (arg) { this.setModel(arg); break; }
        this.status = "collecting models"; this.busy = true; this.dirty = true;
        let models = [];
        try { models = await collectModels(this.cfg); } catch {}
        this.busy = false; this.status = "";
        if (!models.length) { sys(err("✖ no models — run /setup")); break; }
        const items = models.map((m) => ({
          label: (m.id === this.cfg.model.id ? ok("● ") : "  ") + m.id,
          hint: m.hint, value: m.id + "\x01" + m.provider,
        }));
        items.push({ label: dim("  ✎ custom model id…"), value: "__custom__" });
        const picked = await this.pick("Select model", items);
        if (!picked) break;
        if (picked === "__custom__") {
          const id = await this.promptInput("model id (e.g. ollama:qwen3:8b)");
          if (id) this.setModel(id);
        } else {
          const [id, provider] = picked.split("\x01");
          this.cfg.model = { provider, id };
          saveConfig(this.cfg);
          sys(`${ok("✔")} model → ${aqua(id)}`);
        }
        break;
      }

      case "models": {
        this.status = "collecting models"; this.busy = true; this.dirty = true;
        let models = [];
        try { models = await collectModels(this.cfg); } catch {}
        this.busy = false; this.status = "";
        if (!models.length) { sys(err("✖ none — run /setup")); break; }
        sys(models.map((m) =>
          (m.id === this.cfg.model.id ? ok("● ") : dim("· ")) + aqua(m.id) + "  " + dim(m.hint || m.provider)
        ).join("\n"));
        break;
      }

      case "router": {
        if (!this.cfg.router.enabled && !this.cfg.fastModel?.id) {
          this.status = "collecting models"; this.busy = true; this.dirty = true;
          let models = [];
          try { models = await collectModels(this.cfg); } catch {}
          this.busy = false; this.status = "";
          const items = models.map((m) => ({ label: "  " + m.id, hint: m.hint, value: m.id + "\x01" + m.provider }));
          const picked = await this.pick("Fast model for the router", items);
          if (!picked) break;
          const [id, provider] = picked.split("\x01");
          this.cfg.fastModel = { provider, id };
        }
        this.cfg.router.enabled = !this.cfg.router.enabled;
        saveConfig(this.cfg);
        sys(`${ok("✔")} neural router ${this.cfg.router.enabled ? ok("ON") + dim(" → " + this.cfg.fastModel.id) : warn("OFF")}`);
        break;
      }

      case "memory":
        sys([
          `${violet("◆")} ${this.memory.stats()}`,
          `${violet("◆")} user model: ${this.memory.user.traits.length} traits · ${this.memory.user.preferences.length} preferences`,
          this.memory.user.traits.length ? dim("  " + this.memory.user.traits.slice(0, 5).join(" · ")) : "",
        ].filter(Boolean).join("\n"));
        break;

      case "facts": {
        const facts = [...this.memory.facts].sort((a, b) => b.importance - a.importance);
        if (!facts.length) { sys(dim("no facts yet — talk to me!")); break; }
        sys(facts.slice(0, 30).map((f) => {
          const bar = "█".repeat(Math.round(f.importance * 5)).padEnd(5, "░");
          return `${violet(bar)} ${f.text} ${dim("[" + f.type + "]")}`;
        }).join("\n"));
        break;
      }

      case "remember":
        if (!arg) { sys(dim("usage: /remember <fact>")); break; }
        this.memory.addFact(arg, { type: "user", importance: 0.8 });
        this.memory.persist();
        sys(`${ok("✔")} remembered`);
        break;

      case "forget": {
        if (!arg) { sys(dim("usage: /forget <text>")); break; }
        const n = this.memory.forget(arg);
        this.memory.persist();
        sys(n ? `${ok("✔")} forgot ${n} memor${n > 1 ? "ies" : "y"}` : dim("nothing matched"));
        break;
      }

      case "dream": {
        this.busy = true; this.status = "💤 dreaming"; this.dirty = true;
        try {
          const r = await this.memory.dream(this.cfg, this.cfg.fastModel?.id ? this.cfg.fastModel : this.cfg.model,
            { log: (t) => { this.status = "💤 " + t; this.dirty = true; } });
          sys(`${violet("💤")} dream complete: ${ok("+" + r.extracted + " facts")} · ${r.mergedCount} merged · ${r.pruned} pruned · ${violet("🧬 " + (r.genes ?? 0) + " genes")}`);
        } catch (e) { sys(err("✖ dream failed: ") + e.message); }
        this.busy = false; this.status = "";
        break;
      }

      case "skills": {
        const skills = loadSkills();
        if (!skills.length) { sys(dim("no forged skills yet — Aion creates them as it works")); break; }
        sys(skills.map((s) => `${violet("⚒")} ${bold(s.name)} ${dim("— " + s.description)}`).join("\n"));
        break;
      }

      case "persona":
        if (!arg) { sys("persona: " + dim(this.cfg.agent.persona)); break; }
        this.cfg.agent.persona = arg;
        saveConfig(this.cfg);
        sys(`${ok("✔")} persona reshaped`);
        break;

      case "setup": {
        clearInterval(this.timer);
        this.term.exit();
        const rl = createInterface();
        try { await runSetup(this.cfg, rl); } catch {}
        rl.close();
        this.term.enter();
        this.timer = setInterval(() => { if (this.dirty || this.busy) { this.render(); this.dirty = false; } }, 33);
        this._wrap.clear();
        sys(`${ok("✔")} setup done · model ${aqua(this.cfg.model.id)}`);
        break;
      }

      case "clear":
        this.msgs = []; this._wrap.clear(); this.scroll = 0; this.dirty = true;
        break;

      case "reset": {
        const sure = await this.promptInput("wipe ALL memory? type yes");
        if (sure === "yes") {
          this.memory.episodes = []; this.memory.facts = []; this.memory.procedures = [];
          this.memory.user = { name: "", traits: [], preferences: [], topics: {} };
          this.memory.persist();
          sys(`${ok("✔")} memory wiped`);
        } else sys(dim("cancelled"));
        break;
      }

      case "stats": {
        const top = [...this.memory.facts].sort((a, b) => b.accessCount - a.accessCount).slice(0, 3);
        sys([
          `${violet("◆")} model ${aqua(this.cfg.model.id)} ${dim("(" + this.cfg.model.provider + ")")}`,
          `${violet("◆")} router ${this.cfg.router.enabled ? ok("on → " + this.cfg.fastModel.id) : dim("off")}`,
          `${violet("◆")} ${this.memory.stats()}`,
          top.length ? `${violet("◆")} most recalled: ${dim(top.map((f) => f.text.slice(0, 40)).join(" · "))}` : "",
        ].filter(Boolean).join("\n"));
        break;
      }

      case "exit": case "quit": case "q":
        await this.quit();
        break;

      default:
        sys(dim("unknown command — /help or Ctrl+P"));
    }
    this.dirty = true;
  }

  setModel(arg) {
    for (const p of Object.keys(PROVIDERS)) {
      if (arg.startsWith(p + ":")) {
        this.cfg.model = { provider: p, id: arg.slice(p.length + 1) };
        saveConfig(this.cfg);
        this.add("sys", `${ok("✔")} model → ${aqua(this.cfg.model.id)}`);
        return;
      }
    }
    this.cfg.model = { provider: this.cfg.providers.ollama ? "ollama" : this.cfg.model.provider, id: arg };
    saveConfig(this.cfg);
    this.add("sys", `${ok("✔")} model → ${aqua(arg)}`);
  }

  // ── rendering ──────────────────────────────────────────
  viewH() { return Math.max(1, this.term.size().rows - 3 - (this._lastInputH || 1)); }

  chatLines(width) {
    const out = [];
    const bw = width - 2; // block width (1 col margin each side)
    for (const m of this.msgs) {
      let cached = this._wrap.get(m);
      if (!cached || cached.width !== width || cached.src !== m.text) {
        let lines;
        if (m.kind === "user") {
          const wrapped = wrapAnsi(m.text, bw - 6);
          const block = (content) => {
            const pad = Math.max(0, bw - 4 - visLen(content));
            return " " + BG + fg(99) + "▌ " + fg(253) + content + " ".repeat(pad) + "  " + RESET;
          };
          lines = [block(""), ...wrapped.map(block), block("")];
        } else {
          // streaming markdown: live ai messages render markdown as tokens arrive
          const text = m.kind === "ai" && !m.done ? renderMarkdown(m.text) : m.text;
          lines = wrapAnsi(text, width - 4).map((l) => "  " + l);
        }
        cached = { width, src: m.text, lines };
        this._wrap.set(m, cached);
      }
      out.push(...cached.lines, "");
    }
    return out;
  }

  // builds the input block (1..6 text rows + footer); returns rows + click info
  buildInput(w) {
    const I = this.input;
    const inner = w - 7;
    const lines = I.text.split("\n");

    // locate the cursor: line index + column
    let off = 0, cl = 0, cc = 0;
    for (let i = 0; i < lines.length; i++) {
      if (I.cur <= off + lines[i].length) { cl = i; cc = I.cur - off; break; }
      off += lines[i].length + 1;
      if (i === lines.length - 1) { cl = i; cc = lines[i].length; }
    }

    // vertical window (max 6 rows) keeps the cursor line visible
    const maxRows = 6;
    let top = this._vscroll || 0;
    if (cl < top) top = cl;
    if (cl > top + maxRows - 1) top = cl - maxRows + 1;
    top = Math.max(0, Math.min(top, Math.max(0, lines.length - maxRows)));
    this._vscroll = top;

    // horizontal scroll follows the cursor on its line
    let h = this._hscroll || 0;
    if (cc < h) h = cc;
    if (cc > h + inner - 1) h = Math.max(0, cc - inner + 1);
    this._hscroll = h;

    const barCol = this.capture ? 214 : 99;
    const rowsOut = lines.slice(top, top + maxRows).map((ln, vi) => {
      const isCur = top + vi === cl;
      const view = isCur ? ln.slice(h, h + inner) : ln.slice(0, inner);
      let content = "", used = 0;
      if (!I.text.length) {
        content = "\x1b[7m \x1b[27m" + fg(242) + (this.capture ? this.capture.label : 'Ask anything…   "/": commands');
        used = 1 + (this.capture ? this.capture.label.length : 30);
      } else if (isCur) {
        const curIdx = cc - h;
        for (let i = 0; i < view.length; i++) {
          content += i === curIdx ? "\x1b[7m" + view[i] + "\x1b[27m" : view[i];
        }
        used = view.length;
        if (curIdx >= view.length) { content += "\x1b[7m \x1b[27m"; used++; }
      } else {
        content = view;
        used = visLen(view);
      }
      const prompt = top + vi === 0 ? "❯ " : "· ";
      return " " + BG + fg(barCol) + "▌ " + fg(87) + prompt + fg(253) + content +
        " ".repeat(Math.max(0, w - 6 - used)) + RESET;
    });

    const modelId = this.cfg.model.id;
    const prov = this.cfg.model.provider === "ollama" ? "Ollama" : this.cfg.model.provider;
    const routerTag = this.cfg.router?.enabled ? ` · router→${this.cfg.fastModel.id}` : "";
    const footPlain = `aion · ${modelId} ${prov}${routerTag}`;
    const foot = fg(245) + "aion " + fg(240) + "· " + fg(87) + modelId + " " + fg(240) + prov + fg(240) + routerTag;
    const footerRow = " " + BG + fg(barCol) + "▌ " + foot +
      " ".repeat(Math.max(0, w - 4 - visLen(footPlain))) + RESET;

    return {
      rows: rowsOut, footerRow,
      textXrel: 5,                                  // margin(1) + bar(2) + "❯ "(2) → first char col
      modelX1rel: 1 + 2 + 7,                        // margin + bar + "aion · "
      modelX2rel: 1 + 2 + 7 + modelId.length,
    };
  }

  render() {
    const { cols, rows } = this.term.size();
    if (cols < 24 || rows < 8) return;
    const S = new Array(rows + 1).fill("");

    if (!this.msgs.length && !this.busy) this.renderEmpty(S, cols, rows);
    else this.renderChat(S, cols, rows);
    this.renderStatusBar(S, cols, rows);

    let buf = "\x1b[?2026h";
    for (let r = 1; r <= rows; r++) {
      buf += `\x1b[${r};1H\x1b[2K` + padTrunc(S[r] || "", cols);
    }
    if (this.overlay) buf += this.renderOverlay(cols, rows);
    buf += "\x1b[?2026l";
    this.term.write(buf);
  }

  renderEmpty(S, cols, rows) {
    const logoW = 31;
    const lx = Math.max(0, Math.floor((cols - logoW) / 2));
    let y = Math.max(2, Math.floor(rows * 0.26));
    for (const line of LOGO) {
      if (y < rows - 6) S[y++] = " ".repeat(lx) + gradient(line);
    }
    S[y++] = "";
    const w = Math.min(cols - 6, 84);
    const x = Math.max(1, Math.floor((cols - w) / 2));
    const inp = this.buildInput(w);
    this._lastInputH = inp.rows.length;
    const margin = " ".repeat(x - 1);
    this._inputPos = { y, h: inp.rows.length, textX: x + inp.textXrel - 1 };
    for (const row of inp.rows) { S[y] = margin + row.slice(1); y++; }
    S[y] = margin + inp.footerRow.slice(1);
    this._modelZone = { y, x1: x + inp.modelX1rel, x2: x + inp.modelX2rel };
    y += 2;
    const hint = bold("↵") + dim(" send  ") + bold("ctrl+p") + dim(" commands");
    S[y] = " ".repeat(Math.max(0, x + w - visLen(hint))) + hint;
    y += 2;
    const tip = amber("●") + bold(" Tip ") + dim(this._tip);
    S[y] = " ".repeat(Math.max(0, Math.floor((cols - visLen(tip)) / 2))) + tip;
  }

  renderChat(S, cols, rows) {
    const inp = this.buildInput(cols - 2);
    const ih = inp.rows.length;
    this._lastInputH = ih;
    const viewH = Math.max(1, rows - 3 - ih);
    const lines = this.chatLines(cols);
    const maxScroll = Math.max(0, lines.length - viewH);
    if (this.scroll > maxScroll) this.scroll = maxScroll;
    const start = Math.max(0, lines.length - viewH - this.scroll);
    for (let r = 0; r < viewH; r++) {
      S[1 + r] = lines[start + r] ?? "";
    }
    const firstY = rows - 1 - ih;
    for (let i = 0; i < ih; i++) S[firstY + i] = inp.rows[i];
    this._inputPos = { y: firstY, h: ih, textX: 1 + inp.textXrel };
    S[rows - 1] = inp.footerRow;
    this._modelZone = { y: rows - 1, x1: 1 + inp.modelX1rel, x2: 1 + inp.modelX2rel };
  }

  renderStatusBar(S, cols, rows) {
    let left, right;
    const stats = this.memory.stats();
    if (this.busy) {
      left = " " + this.dots() + " " + (this.status || "working") + "  " + bold("esc") + dim(" interrupt");
      right = dim(stats) + " ";
    } else {
      const cwd = process.cwd().replace(os.homedir(), "~");
      left = " " + dim(cwd);
      if (this.goal) left += "  " + violet("🎯") + dim(` ${this.goal.iter}/${this.goal.max}`);
      if (this.autoLoop && this.autoLoop.nextAt !== Infinity) {
        left += "  " + violet("⟳") + dim(` ${fmtMs(Math.max(0, this.autoLoop.nextAt - Date.now()))}`);
      }
      right = bold("ctrl+p") + dim(" commands") + "  " + dim(stats + " · v" + this.version) + " ";
    }
    if (this.scroll > 0) right = dim(`↑${this.scroll} `) + right;
    const gap = Math.max(1, cols - visLen(left) - visLen(right));
    S[rows] = left + " ".repeat(gap) + right;
  }

  dots() {
    const n = 10;
    const t = Math.floor(Date.now() / 90) % n;
    let s = "";
    for (let i = 0; i < n; i++) {
      const d = Math.min(Math.abs(i - t), n - Math.abs(i - t));
      s += d <= 1 ? fg(87) + "·" : d === 2 ? fg(99) + "·" : fg(238) + "·";
    }
    return s + RESET;
  }

  renderOverlay(cols, rows) {
    const O = this.overlay;
    const w = Math.min(68, cols - 4);
    const maxItems = Math.max(3, rows - 8);
    const h = Math.min(O.items.length, maxItems) + 2;
    const x = Math.floor((cols - w) / 2);
    const y = Math.max(2, Math.floor((rows - 2 - h) / 2));
    O.box = { x, y, w, h };

    const inner = h - 2;
    if (O.sel < O.top) O.top = O.sel;
    if (O.sel >= O.top + inner) O.top = O.sel - inner + 1;

    let buf = "";
    const title = ` ${O.title} `;
    const head = "╭─" + title;
    buf += `\x1b[${y};${x}H` + violet(head + "─".repeat(Math.max(0, w - visLen(head) - 1)) + "╮");
    for (let i = 0; i < inner; i++) {
      const idx = O.top + i;
      const item = O.items[idx];
      let row;
      if (item) {
        const sel = idx === O.sel;
        if (sel) {
          const plain = stripAnsi(item.label) + (item.hint ? "  " + item.hint : "");
          row = "\x1b[48;5;55m\x1b[97m " + plain.padEnd(w - 4).slice(0, w - 4) + " " + RESET;
        } else {
          row = " " + padTrunc(item.label + (item.hint ? "  " + dim(item.hint) : ""), w - 4) + " ";
        }
      } else row = " ".repeat(w - 2);
      buf += `\x1b[${y + 1 + i};${x}H` + violet("│") + row + violet("│");
    }
    const more = O.items.length > inner ? dim(` ${O.sel + 1}/${O.items.length} `) : "";
    const moreLen = visLen(more);
    buf += `\x1b[${y + h - 1};${x}H` + violet("╰" + "─".repeat(Math.max(0, w - 2 - moreLen))) + more + violet("╯");
    return buf;
  }
}
