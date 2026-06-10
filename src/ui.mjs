// AION UI — zero-dependency ANSI terminal toolkit
import readline from "node:readline";

const ESC = "\x1b[";
export const c = {
  reset: `${ESC}0m`, bold: `${ESC}1m`, dim: `${ESC}2m`, italic: `${ESC}3m`,
  underline: `${ESC}4m`, inverse: `${ESC}7m`, strikethrough: `${ESC}9m`,
  black: `${ESC}30m`, red: `${ESC}31m`, green: `${ESC}32m`, yellow: `${ESC}33m`,
  blue: `${ESC}34m`, magenta: `${ESC}35m`, cyan: `${ESC}36m`, white: `${ESC}37m`,
  gray: `${ESC}90m`, brightRed: `${ESC}91m`, brightGreen: `${ESC}92m`,
  brightYellow: `${ESC}93m`, brightBlue: `${ESC}94m`, brightMagenta: `${ESC}95m`,
  brightCyan: `${ESC}96m`, brightWhite: `${ESC}97m`,
  bgBlue: `${ESC}44m`, bgMagenta: `${ESC}45m`,
};

// AION brand gradient (violet → cyan)
const GRADIENT = [129, 99, 63, 69, 75, 81, 87, 51];
export function gradient(text) {
  const chars = [...text];
  const step = Math.max(1, Math.floor(chars.length / GRADIENT.length));
  return chars
    .map((ch, i) => `${ESC}38;5;${GRADIENT[Math.min(Math.floor(i / step), GRADIENT.length - 1)]}m${ch}`)
    .join("") + c.reset;
}

export const violet = (s) => `${ESC}38;5;135m${s}${c.reset}`;
export const aqua = (s) => `${ESC}38;5;51m${s}${c.reset}`;
export const ok = (s) => `${c.brightGreen}${s}${c.reset}`;
export const warn = (s) => `${c.brightYellow}${s}${c.reset}`;
export const err = (s) => `${c.brightRed}${s}${c.reset}`;
export const dim = (s) => `${c.gray}${s}${c.reset}`;
export const bold = (s) => `${c.bold}${s}${c.reset}`;

export function banner(version, modelLabel, memoryStats) {
  const art = [
    "      ╔═╗ ╦ ╔═╗ ╔╗╔",
    "      ╠═╣ ║ ║ ║ ║║║",
    "      ╩ ╩ ╩ ╚═╝ ╝╚╝",
  ];
  console.log();
  for (const line of art) console.log("  " + gradient(line));
  console.log(dim(`  ────────────────────────────────────────────`));
  console.log(`  ${violet("◆")} ${bold("AION")} ${dim("v" + version)} ${dim("— the eternal agent")}`);
  if (modelLabel) console.log(`  ${violet("◆")} model: ${aqua(modelLabel)}`);
  if (memoryStats) console.log(`  ${violet("◆")} memory: ${dim(memoryStats)}`);
  console.log(dim(`  ────────────────────────────────────────────`));
  console.log(dim(`  /help for commands · /dream to consolidate memory\n`));
}

// ── Spinner ──────────────────────────────────────────────
const FRAMES = ["◐", "◓", "◑", "◒"];
export class Spinner {
  constructor(text = "thinking") { this.text = text; this.i = 0; this.timer = null; }
  start() {
    if (!process.stdout.isTTY) return this;
    process.stdout.write("\x1b[?25l");
    this.timer = setInterval(() => {
      process.stdout.write(`\r${violet(FRAMES[this.i++ % FRAMES.length])} ${dim(this.text)}  `);
    }, 120);
    return this;
  }
  update(text) { this.text = text; }
  stop(finalText = "") {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (process.stdout.isTTY) {
      process.stdout.write(`\r${" ".repeat(this.text.length + 8)}\r\x1b[?25h`);
    }
    if (finalText) console.log(finalText);
  }
}

function osc8(url, text) {
  return `\x1b]8;;${url}\x07${c.underline}${ESC}38;5;81m${text}${c.reset}\x1b]8;;\x07`;
}

// ── Lightweight markdown renderer for terminal ──────────
export function renderMarkdown(md) {
  let out = md;
  // code blocks
  out = out.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const lines = code.replace(/\n$/, "").split("\n");
    const header = lang ? dim(`╭─ ${lang}`) : dim("╭─");
    const body = lines.map((l) => dim("│ ") + `${ESC}38;5;222m${l}${c.reset}`).join("\n");
    return `${header}\n${body}\n${dim("╰─")}`;
  });
  // headings
  out = out.replace(/^### (.*)$/gm, (_, t) => bold(violet(t)));
  out = out.replace(/^## (.*)$/gm, (_, t) => bold(violet("◆ " + t)));
  out = out.replace(/^# (.*)$/gm, (_, t) => bold(gradient("◆◆ " + t)));
  // clickable hyperlinks (OSC 8 — supported by Windows Terminal)
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => osc8(u, t));
  out = out.replace(/(?<![("'\]\w])(https?:\/\/[^\s<>"\])]+)/g, (u) => osc8(u, u));
  // bold / italic / inline code
  out = out.replace(/\*\*(.+?)\*\*/g, (_, t) => bold(t));
  out = out.replace(/(?<![\w*])\*([^*\n]+)\*(?![\w*])/g, (_, t) => `${c.italic}${t}${c.reset}`);
  out = out.replace(/`([^`\n]+)`/g, (_, t) => `${ESC}38;5;222m${t}${c.reset}`);
  // bullets
  out = out.replace(/^(\s*)[-*] /gm, (_, sp) => sp + violet("• "));
  return out;
}

// ── Prompt helpers ───────────────────────────────────────
export function createInterface() {
  return readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
}

export function ask(rl, question) {
  return new Promise((resolve) => rl.question(question, (a) => resolve(a.trim())));
}

export async function askHidden(rl, question) {
  // mask input for API keys
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    let buf = "";
    const onData = (chunk) => {
      const s = chunk.toString("utf8");
      for (const ch of s) {
        if (ch === "\r" || ch === "\n") {
          stdin.removeListener("data", onData);
          if (stdin.isTTY) stdin.setRawMode(false);
          process.stdout.write("\n");
          resolve(buf.trim());
          return;
        } else if (ch === "\x7f" || ch === "\b") {
          if (buf.length) { buf = buf.slice(0, -1); process.stdout.write("\b \b"); }
        } else if (ch === "\x03") {
          process.stdout.write("\n"); process.exit(130);
        } else {
          buf += ch;
          process.stdout.write("*");
        }
      }
    };
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

export async function select(rl, title, options, { allowCustom = false } = {}) {
  // options: [{label, value, hint}]
  console.log(`\n${bold(title)}`);
  options.forEach((o, i) => {
    console.log(`  ${aqua(String(i + 1).padStart(2))} ${o.label}${o.hint ? "  " + dim(o.hint) : ""}`);
  });
  if (allowCustom) console.log(`  ${aqua(" 0")} ${dim("enter custom value…")}`);
  for (;;) {
    const a = await ask(rl, violet("  ❯ "));
    const n = parseInt(a, 10);
    if (allowCustom && (a === "0" || (isNaN(n) && a))) {
      if (a === "0") {
        const custom = await ask(rl, dim("  custom: "));
        if (custom) return { label: custom, value: custom, custom: true };
      } else return { label: a, value: a, custom: true };
    }
    if (n >= 1 && n <= options.length) return options[n - 1];
    console.log(dim("  pick a number from the list"));
  }
}
