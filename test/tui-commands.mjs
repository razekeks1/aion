// TUI hardening harness — drives every offline slash command and edge case
// through the real App class without a terminal. run: node test/tui-commands.mjs
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// isolated data dir — the harness must never touch real ~/.aion memory
process.env.AION_HOME = path.join(os.tmpdir(), "aion-test-tui-" + Date.now());

// neutralize TTY requirements before importing the repl
process.stdout.isTTY = true;
process.stdin.isTTY = true;

const { runRepl, cpPrev, cpNext } = await import("../src/repl.mjs");
const { loadConfig } = await import("../src/config.mjs");

let failed = 0;
const check = (name, cond) => {
  console.log((cond ? "  ok  " : "  FAIL") + " " + name);
  if (!cond) failed++;
};

// Reach the App class through runRepl's module — re-import internals by
// constructing via a tiny shim: we import the module source and eval App?
// Simpler: replicate by importing the class indirectly. The module doesn't
// export App, so instead we test command handling through a crafted instance.
import { Term } from "../src/tui.mjs";

// stub Term so nothing touches the real terminal
Term.prototype.enter = function () {};
Term.prototype.exit = function () {};
Term.prototype.write = function () {};
Term.prototype.size = function () { return { cols: 100, rows: 30 }; };

// grab the App class via the module namespace trick: runRepl creates one.
// We intercept by calling runRepl with a never-resolving run() — instead,
// patch: import source and extract class is fragile. We instead simulate the
// full app loop with a real instance obtained from a tiny export added below.
const replSrc = await import("../src/repl.mjs");
const App = replSrc.App ?? null;

if (!App) {
  console.log("  FAIL App class not exported — export it for testing");
  process.exit(1);
}

const cfg = loadConfig();
const app = new App(cfg, "test", null);
app.timer = setInterval(() => {}, 100000); // dummy so quit()'s clearInterval works
app.render = () => {}; // never draw

const offlineCommands = [
  "/help", "/genome", "/genome pin 99", "/genome reset", "/memory", "/facts",
  "/remember smoketest-tui fact", "/forget smoketest-tui", "/skills",
  "/persona", "/stats", "/telegram", "/export " + path.join(os.tmpdir(), "aion-test-export.md"),
  "/unknowncommand", "/clear",
];

for (const cmd of offlineCommands) {
  try {
    await app.command(cmd);
    check(`command ${cmd.split(" ")[0]} ok`, true);
  } catch (e) {
    check(`command ${cmd} crashed: ${e.message}`, false);
  }
}

// /export actually wrote the file
const exp = path.join(os.tmpdir(), "aion-test-export.md");
// history is empty → export says "nothing to export"; now add history and retry
app.history.push({ role: "user", content: "test 🚀" }, { role: "assistant", content: "ok" });
await app.command("/export " + exp);
check("/export writes file", fs.existsSync(exp) && fs.readFileSync(exp, "utf8").includes("🚀"));
try { fs.unlinkSync(exp); } catch {}

// edge cases: input events
try {
  app.onEvent({ type: "char", ch: "🚀" });
  app.onEvent({ type: "char", ch: "x" });
  app.onEvent({ type: "key", name: "left" });
  app.onEvent({ type: "key", name: "left" });
  check("emoji input cursor lands at 0", app.input.cur === 0);
  app.onEvent({ type: "key", name: "right" });
  check("right over emoji = +2 units", app.input.cur === 2);
  app.onEvent({ type: "key", name: "backspace" });
  check("backspace removes whole emoji", app.input.text === "x");
  app.onEvent({ type: "key", name: "ctrl-u" });
  check("ctrl-u clears", app.input.text === "");
} catch (e) { check("input edge cases crashed: " + e.message, false); }

// multiline: paste keeps newlines, ctrl-j inserts them, ↑↓ navigate lines
app.onEvent({ type: "paste", text: "line1\nline2\nline3" });
check("paste keeps newlines", app.input.text.split("\n").length === 3);
check("buildInput multi-row", app.buildInput(60).rows.length === 3);
app.onEvent({ type: "key", name: "up" });
check("up moves a line, not history", app.input.text.includes("line1") && app.input.cur < app.input.text.length);
app.onEvent({ type: "key", name: "home" });
check("home goes to line start", app.input.text[app.input.cur - 1] === "\n" || app.input.cur === 0);
app.input.text = ""; app.input.cur = 0;
app.onEvent({ type: "char", ch: "a" });
app.onEvent({ type: "key", name: "ctrl-j" });
app.onEvent({ type: "char", ch: "b" });
check("ctrl-j inserts newline", app.input.text === "a\nb");
app.input.text = "x\\"; app.input.cur = 2;
app.onEvent({ type: "key", name: "enter" });
check("backslash+enter continues line", app.input.text === "x\n");
app.input.text = ""; app.input.cur = 0;
app.onEvent({ type: "paste", text: "y".repeat(5000) });
check("huge paste survives", app.input.text.length === 5000);
app.input.text = ""; app.input.cur = 0;

// empty submit is a no-op
const msgsBefore = app.msgs.length;
await app.submit();
check("empty submit no-op", app.msgs.length === msgsBefore);

// tiny window render guard
app.render = App.prototype.render.bind(app);
app.term.size = () => ({ cols: 10, rows: 4 });
try { app.render(); check("tiny window render guarded", true); }
catch (e) { check("tiny window crashed: " + e.message, false); }
app.term.size = () => ({ cols: 100, rows: 30 });

// chatLines with unicode + very long word
app.msgs.push({ kind: "ai", text: "🚀".repeat(200) + " " + "Donaudampfschifffahrtsgesellschaftskapitän".repeat(5), done: true });
try { app.chatLines(60); check("chatLines handles unicode walls", true); }
catch (e) { check("chatLines crashed: " + e.message, false); }

// /sessions: empty state, then resume a saved one
await app.command("/sessions");
check("/sessions empty state ok", true);
{
  const { saveSession } = await import("../src/sessions.mjs");
  saveSession("tuitest-1", [
    { role: "user", content: "resume me" },
    { role: "assistant", content: "sure" },
  ]);
  const cmdP = app.command("/sessions");
  await new Promise((r) => setTimeout(r, 20)); // let the picker open
  app.overlayEvent({ type: "key", name: "enter" });
  await cmdP;
  check("/sessions resumes history", app.history.some((m) => m.content === "resume me"));
  check("/sessions switches id", app.sessionId === "tuitest-1");
}

// overlay picker open/close
const p = app.pick("test", [{ label: "a", value: 1 }, { label: "b", value: 2 }]);
app.overlayEvent({ type: "key", name: "down" });
app.overlayEvent({ type: "key", name: "enter" });
check("overlay pick returns value", (await p) === 2);

// ── context tracking + /compact guard rails ──
{
  app.history = [
    { role: "user", content: "hello there" },
    { role: "assistant", content: "hi! ".repeat(50) },
  ];
  app._est = null;
  const est = app.estTokens();
  check("estTokens counts system+history", est > 50);
  const cached = app.estTokens();
  check("estTokens caches", cached === est);
  await app.command("/compact"); // <6 messages → friendly no-op, no model call
  check("/compact small-history no-op", app.history.length === 2);
  await app.command("/memory");
  check("/memory explains the brain", true);
  await app.command("/stats");
  check("/stats with ctx gauge ok", true);
}

// ── /goal: completes when the model says GOAL_COMPLETE ──
{
  const realTurn = app.turn.bind(app);
  let turns = 0;
  app.turn = async (line, display) => {
    turns++;
    app.history.push({ role: "user", content: line });
    app.history.push({ role: "assistant", content: turns >= 2 ? "all verified. GOAL_COMPLETE" : "step 1 done, continuing" });
  };
  await app.command("/goal smoketest: tiny goal");
  check("goal runs first iteration", turns === 1 && app.goal && app.goal.iter === 1);
  check("goal schedules next iteration", app.goal.resumeAt > 0);
  app.goal.resumeAt = 1; // make it due
  app.tickAutomations();
  await new Promise((r) => setTimeout(r, 30));
  check("goal completes on GOAL_COMPLETE", app.goal === null && turns === 2);

  // paused when a turn produces nothing (e.g. user pressed Esc)
  app.turn = async () => {};
  await app.command("/goal smoketest: doomed goal");
  check("goal pauses on empty turn", app.goal !== null && app.goal.resumeAt === 0);
  await app.command("/goal clear");
  check("goal clear works", app.goal === null);
  app.turn = realTurn;
}

// ── /loop: arm, tick, stop ──
{
  const realTurn = app.turn.bind(app);
  let runs = 0;
  app.turn = async () => { runs++; };
  await app.command("/loop 5m say hi");
  check("loop armed with interval", app.autoLoop?.intervalMs === 300000);
  app.tickAutomations();
  await new Promise((r) => setTimeout(r, 30));
  check("loop first run fired", runs === 1);
  check("loop re-armed ~5m out", app.autoLoop.nextAt - Date.now() > 290000);
  await app.command("/loop status");
  check("loop status ok", true);
  await app.command("/loop stop");
  check("loop stop clears", app.autoLoop === null);
  await app.command("/loop 10s too fast");
  check("loop rejects <30s interval", app.autoLoop === null);
  await app.command("/loop 5m /loop nope");
  check("loop refuses recursion", app.autoLoop === null);
  app.turn = realTurn;
}

clearInterval(app.timer);
try { fs.rmSync(process.env.AION_HOME, { recursive: true, force: true }); } catch {}
console.log(failed ? `\n${failed} FAILED` : "\nall tui command tests passed");
process.exit(failed ? 1 : 0);
