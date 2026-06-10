// AION smoke tests — run with: node test/smoke.mjs
// Runs against an isolated AION_HOME so real user memory is never touched.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
// must be set before any src module loads (they read it at import time),
// so all src imports below are dynamic
process.env.AION_HOME = path.join(os.tmpdir(), "aion-test-home-" + Date.now());

const { resilientChat, routeModel, councilSeats } = await import("../src/agent.mjs");
const { Memory, detectFeedback, similarity } = await import("../src/memory.mjs");
const { wrapAnsi, padTrunc, visLen, stripAnsi } = await import("../src/tui.mjs");
const { newSessionId, saveSession, loadSession, exportMarkdown, sessionPath } = await import("../src/sessions.mjs");
const { cpPrev, cpNext } = await import("../src/repl.mjs");
const { renderMarkdown } = await import("../src/ui.mjs");
const { loadConfig } = await import("../src/config.mjs");
const { toolDefinitions } = await import("../src/tools.mjs");

let failed = 0;
const check = (name, cond) => {
  console.log((cond ? "  ok  " : "  FAIL") + " " + name);
  if (!cond) failed++;
};

// ── Aegis: retry + failover against a fake flaky provider ──
// We simulate by pointing "ollama" at an unreachable port: every call throws
// a network error (retryable) → should retry primary then fail over through
// the chain and finally throw (no fallbacks configured here).
{
  const cfg = {
    providers: { ollama: { host: "http://127.0.0.1:9" } }, // port 9 = discard, refuses
    model: { provider: "ollama", id: "primary-model" },
    fastModel: { provider: "ollama", id: "backup-model" },
  };
  const events = [];
  let threw = false;
  try {
    await resilientChat(cfg, cfg.model, { messages: [{ role: "user", content: "x" }] },
      (ev) => events.push(ev.type + ":" + (ev.model || ev.to || "")));
  } catch { threw = true; }
  const retries = events.filter((e) => e.startsWith("retry")).length;
  const failovers = events.filter((e) => e.startsWith("failover")).length;
  check(`aegis retried primary (${retries}×)`, retries === 2);
  check(`aegis failed over (${failovers}×)`, failovers >= 1);
  check("aegis throws only after exhausting chain", threw);
}

// ── Evolution Engine: feedback detection ──
check("neg feedback (de)", detectFeedback("nein das ist falsch") === "neg");
check("neg feedback (redo)", detectFeedback("mach das nochmal anders") === "neg");
check("pos feedback (de)", detectFeedback("perfekt danke!") === "pos");
check("pos feedback (en)", detectFeedback("great, exactly what I wanted") === "pos");
check("neutral text", detectFeedback("wie wird das wetter morgen") === null);

// ── memory: genome block + procedures ──
{
  const m = new Memory();
  const before = m.genome.feedback.length;
  m.recordFeedback("neg", "test context");
  check("feedback recorded", m.genome.feedback.length === before + 1);
  m.genome.feedback.pop(); // don't pollute real memory
  m.genome.rules = [{ text: "answer in German", ts: Date.now() }];
  check("genome block renders", m.genomeBlock().includes("answer in German"));
  m.genome.rules = [];
}

// ── similarity sanity ──
check("similarity high for near-dupes", similarity("Mein Server heißt atlas", "Der Server heißt atlas") > 0.5);
check("similarity low for unrelated", similarity("Pizza Rezept", "Quantenphysik Vorlesung") < 0.3);

// ── TUI primitives ──
{
  const lines = wrapAnsi("\x1b[31mDies ist ein langer roter Text der mehrfach umbrochen werden muss\x1b[0m", 16);
  check("wrapAnsi respects width", lines.every((l) => visLen(l) <= 16));
  check("padTrunc exact width", visLen(padTrunc("\x1b[32mhi\x1b[0m", 12)) === 12);
}

// ── sessions: save / load roundtrip + export ──
{
  const id = "smoketest-" + newSessionId();
  const hist = [
    { role: "user", content: "Hallo 🌍, wie geht's?" },
    { role: "assistant", content: "Sehr gut! **Markdown** works." },
  ];
  saveSession(id, hist, { model: "test-model" });
  const loaded = loadSession(id);
  check("session roundtrip", loaded?.history?.length === 2 && loaded.history[0].content.includes("🌍"));
  check("session title derived", loaded.title.startsWith("Hallo"));
  check("session turn count", loaded.turns === 1);
  try { fs.unlinkSync(sessionPath(id)); } catch {}
  const md = exportMarkdown(hist, { agentName: "Aion", model: "test-model" });
  check("export contains user turn", md.includes("Hallo 🌍"));
  check("export contains assistant turn", md.includes("**Markdown** works"));
  check("export has header", md.startsWith("# Aion — Conversation Export"));
}

// ── neural router ──
{
  const cfg = {
    model: { provider: "ollama", id: "big" },
    fastModel: { provider: "ollama", id: "small" },
    router: { enabled: true },
  };
  check("router: simple → fast", routeModel(cfg, "hi, wie spät ist es", []).tier === "fast");
  check("router: code → smart", routeModel(cfg, "implement a binary search in python", []).tier === "smart");
  check("router: long → smart", routeModel(cfg, "x".repeat(300) + " analyse this deeply please", []).tier === "smart");
  check("router off → smart", routeModel({ ...cfg, router: { enabled: false } }, "hi", []).tier === "smart");
}

// ── council v2: configurable seats ──
{
  const cfg = {
    model: { provider: "ollama", id: "main" },
    fastModel: { provider: "ollama", id: "fast" },
    providers: {},
    council: { seats: [
      { role: "Skeptic", style: "doubt everything", model: "anthropic:claude-sonnet-4-6" },
      { model: { provider: "ollama", id: "qwen3:8b" } },
    ] },
  };
  const seats = councilSeats(cfg);
  check("council v2 custom seat count", seats.length === 2);
  check("council v2 string model parsed", seats[0].model.provider === "anthropic" && seats[0].model.id === "claude-sonnet-4-6");
  check("council v2 default role fills in", typeof seats[1].role === "string" && seats[1].role.length > 0);
  const fallback = councilSeats({ ...cfg, council: { seats: [] } });
  check("council fallback = 3 classic seats", fallback.length === 3);
}

// ── unicode cursor steps ──
{
  const t = "a🚀b"; // 🚀 is a surrogate pair: indices a=0, 🚀=1..2, b=3
  check("cpNext skips surrogate pair", cpNext(t, 1) === 3);
  check("cpPrev skips surrogate pair", cpPrev(t, 3) === 1);
  check("cpPrev clamps at 0", cpPrev(t, 0) === 0);
  check("cpNext clamps at end", cpNext(t, t.length) === t.length);
}

// ── markdown renderer ──
{
  const out = renderMarkdown("# Title\n**bold** and `code`\n- item\n```js\nlet x=1\n```");
  const plain = stripAnsi(out);
  check("md heading rendered", plain.includes("◆◆ Title"));
  check("md bullet rendered", plain.includes("• item"));
  check("md code fence rendered", plain.includes("╭─ js") && plain.includes("│ let x=1"));
  check("md strips ** markers", !plain.includes("**"));
}

// ── config & tools ──
{
  const cfg = loadConfig();
  check("config has council block", typeof cfg.council === "object" && Array.isArray(cfg.council.seats));
  check("config has router block", typeof cfg.router?.enabled === "boolean");
  const defs = toolDefinitions();
  check("≥9 tool definitions", defs.length >= 9);
  check("tools well-formed", defs.every((d) => d.function?.name && d.function?.parameters));
}

// ── genome v2: pinning semantics ──
{
  const m = new Memory();
  const savedRules = m.genome.rules;
  m.genome.rules = [
    { text: "always answer in German", ts: Date.now(), confidence: 0.8, pinned: true },
    { text: "be brief", ts: Date.now(), confidence: 0.4, pinned: false },
  ];
  check("genome block lists rules", m.genomeBlock().includes("always answer in German"));
  const kept = m.genome.rules.filter((r) => r.pinned);
  check("pinned rules identifiable", kept.length === 1 && kept[0].text.includes("German"));
  m.genome.rules = savedRules; // restore — never pollute real memory
}

// ── memory: dup guard + forget ──
{
  const m = new Memory();
  const savedFacts = m.facts;
  m.facts = [];
  m.addFact("smoketest: the user's server is called atlas");
  const before = m.facts.length;
  m.addFact("smoketest: the users server is called atlas"); // near-dup
  check("near-duplicate facts merged", m.facts.length === before);
  check("forget removes by text", m.forget("smoketest") >= 1 && m.facts.length === 0);
  m.facts = savedFacts;
}

try { fs.rmSync(process.env.AION_HOME, { recursive: true, force: true }); } catch {}
console.log(failed ? `\n${failed} FAILED` : "\nall smoke tests passed");
process.exit(failed ? 1 : 0);
