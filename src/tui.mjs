// AION TUI primitives — raw terminal control, key & mouse parsing, ANSI-aware
// text wrapping. Zero dependencies. Resize-proof: the app re-renders the whole
// frame from state, so nothing ever corrupts.

const RESTORE = "\x1b[?2004l\x1b[?1006l\x1b[?1002l\x1b[?25h\x1b[?1049l";

export class Term {
  constructor() {
    this._buf = "";
    this._escTimer = null;
    this._active = false;
    this.onEvent = null;   // ({type:'key'|'char'|'mouse'|'paste', ...})
    this.onResize = null;
  }

  enter() {
    if (this._active) return;
    this._active = true;
    // alt screen, hide cursor, mouse button tracking + SGR coords, bracketed paste
    process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[?1002h\x1b[?1006h\x1b[?2004h");
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    this._data = (d) => this._feed(d.toString("utf8"));
    process.stdin.on("data", this._data);
    this._rs = () => this.onResize?.();
    process.stdout.on("resize", this._rs);
    this._exitHook = () => { if (this._active) process.stdout.write(RESTORE); };
    process.on("exit", this._exitHook);
  }

  exit() {
    if (!this._active) return;
    this._active = false;
    process.stdin.off("data", this._data);
    process.stdout.off("resize", this._rs);
    process.off("exit", this._exitHook);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write(RESTORE);
  }

  size() {
    return { cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 };
  }

  write(s) { process.stdout.write(s); }

  _emit(ev) { try { this.onEvent?.(ev); } catch {} }

  _feed(s) {
    if (this._escTimer) { clearTimeout(this._escTimer); this._escTimer = null; }
    this._buf += s;
    this._parse();
    if (this._buf === "\x1b") {
      // lone ESC — wait briefly in case it's the start of a sequence
      this._escTimer = setTimeout(() => {
        this._buf = "";
        this._emit({ type: "key", name: "esc" });
      }, 30);
    }
  }

  _parse() {
    let buf = this._buf;
    const out = [];
    while (buf.length) {
      // bracketed paste block
      if (buf.startsWith("\x1b[200~")) {
        const end = buf.indexOf("\x1b[201~");
        if (end === -1) break; // incomplete — wait for more bytes
        out.push({ type: "paste", text: buf.slice(6, end).replace(/\r\n?/g, "\n") });
        buf = buf.slice(end + 6);
        continue;
      }
      if (buf[0] === "\x1b") {
        // Alt+Enter → newline in the input
        if (buf[1] === "\r" || buf[1] === "\n") {
          out.push({ type: "key", name: "ctrl-j" });
          buf = buf.slice(2);
          continue;
        }
        // SGR mouse: \x1b[<b;x;yM (press) or m (release)
        let m = buf.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
        if (m) {
          const b = +m[1], x = +m[2], y = +m[3], press = m[4] === "M";
          let kind = null;
          if (b === 64) kind = "wheel-up";
          else if (b === 65) kind = "wheel-down";
          else if ((b & 3) === 0 && !(b & 32) && press) kind = "click";
          if (kind) out.push({ type: "mouse", kind, x, y });
          buf = buf.slice(m[0].length);
          continue;
        }
        // CSI keys
        m = buf.match(/^\x1b\[([0-9;]*)([A-Za-z~])/);
        if (m) {
          const params = m[1].split(";").map((x) => parseInt(x, 10) || 0);
          const fin = m[2];
          const mod = params[1] || 1;
          const ctrl = mod >= 5;
          const names = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end" };
          if (names[fin]) out.push({ type: "key", name: names[fin], ctrl });
          else if (fin === "~") {
            const t = { 1: "home", 3: "delete", 4: "end", 5: "pgup", 6: "pgdn" }[params[0]];
            if (t) out.push({ type: "key", name: t, ctrl });
          }
          buf = buf.slice(m[0].length);
          continue;
        }
        // SS3 keys (some terminals)
        m = buf.match(/^\x1bO([A-DHF])/);
        if (m) {
          out.push({ type: "key", name: { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end" }[m[1]] });
          buf = buf.slice(m[0].length);
          continue;
        }
        if (buf.length === 1) break; // lone ESC, handled by timer
        // unknown escape — swallow ESC, treat as esc key
        out.push({ type: "key", name: "esc" });
        buf = buf.slice(1);
        continue;
      }
      const ch = buf[0];
      buf = buf.slice(1);
      if (ch === "\r") out.push({ type: "key", name: "enter" });
      else if (ch === "\n") out.push({ type: "key", name: "ctrl-j" }); // Ctrl+J → newline
      else if (ch === "\x7f" || ch === "\b") out.push({ type: "key", name: "backspace" });
      else if (ch === "\t") out.push({ type: "key", name: "tab" });
      else if (ch === "\x03") out.push({ type: "key", name: "ctrl-c" });
      else if (ch === "\x15") out.push({ type: "key", name: "ctrl-u" });
      else if (ch === "\x17") out.push({ type: "key", name: "ctrl-w" });
      else if (ch === "\x0c") out.push({ type: "key", name: "ctrl-l" });
      else if (ch === "\x10") out.push({ type: "key", name: "ctrl-p" });
      else if (ch === "\x01") out.push({ type: "key", name: "home" });
      else if (ch === "\x05") out.push({ type: "key", name: "end" });
      else if (ch >= " ") out.push({ type: "char", ch });
    }
    this._buf = buf;
    for (const ev of out) this._emit(ev);
  }
}

// ── ANSI-aware text utilities ────────────────────────────
const ANSI_ONE = /^(?:\x1b\[[0-9;<=>?]*[A-Za-z~@]|\x1b\]8;;[^\x07\x1b]*(?:\x07|\x1b\\))/;
const ANSI_ALL = /\x1b\[[0-9;<=>?]*[A-Za-z~@]|\x1b\]8;;[^\x07\x1b]*(?:\x07|\x1b\\)/g;

export const stripAnsi = (s) => String(s).replace(ANSI_ALL, "");
export const visLen = (s) => [...stripAnsi(s)].length;

// Truncate to visual width, close ANSI state, pad with spaces to exact width.
export function padTrunc(s, width) {
  const str = String(s);
  let out = "", w = 0, i = 0;
  while (i < str.length && w < width) {
    const m = str.slice(i).match(ANSI_ONE);
    if (m) { out += m[0]; i += m[0].length; continue; }
    out += str[i]; w++; i++;
  }
  return out + "\x1b[0m" + " ".repeat(Math.max(0, width - w));
}

// Word-wrap preserving ANSI codes; SGR state carries onto continuation lines.
export function wrapAnsi(text, width) {
  width = Math.max(8, width);
  const lines = [];
  for (const raw of String(text).split("\n")) {
    let line = "", w = 0;
    let active = [];               // SGR sequences currently in effect
    let lastSpace = -1, lastSpaceW = 0;
    let i = 0;
    while (i < raw.length) {
      const m = raw.slice(i).match(ANSI_ONE);
      if (m) {
        const seq = m[0];
        line += seq;
        if (/^\x1b\[[0-9;]*m$/.test(seq)) {
          if (seq === "\x1b[0m" || seq === "\x1b[m") active = [];
          else active.push(seq);
        }
        i += seq.length;
        continue;
      }
      const ch = raw[i];
      if (w >= width) {
        if (lastSpace > 0 && w - lastSpaceW < 18) {
          const head = line.slice(0, lastSpace);
          const tail = line.slice(lastSpace + 1);
          lines.push(head);
          line = active.join("") + tail;
          w = w - lastSpaceW - 1;
        } else {
          lines.push(line);
          line = active.join("");
          w = 0;
        }
        lastSpace = -1; lastSpaceW = 0;
      }
      if (ch === " ") { lastSpace = line.length; lastSpaceW = w; }
      line += ch;
      w++;
      i++;
    }
    lines.push(line);
  }
  return lines;
}
