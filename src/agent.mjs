// AION agent core — Aegis resilience, neural router, council deliberation,
// parallel tool execution, living system prompt with evolved genome.
import os from "node:os";
import { chat, PROVIDERS } from "./providers.mjs";
import { toolDefinitions, executeTool, loadSkills } from "./tools.mjs";

const MAX_TOOL_ROUNDS = 12;

// ── Aegis Resilience Engine ──────────────────────────────
// A model being overloaded must NEVER kill a turn. Retry with backoff,
// then fail over to backup models transparently, mid-conversation.
const RETRYABLE = /(\b429\b|\b5\d\d\b|overloaded|overload|rate.?limit|capacity|timeout|timed out|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|fetch failed|socket|network|unavailable)/i;

const sleep = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  signal?.addEventListener("abort", () => {
    clearTimeout(t);
    const e = new Error("aborted"); e.name = "AbortError";
    rej(e);
  }, { once: true });
});

function failoverChain(cfg, primary) {
  const chain = [];
  const seen = new Set();
  const push = (m) => {
    if (m?.id && !seen.has(m.provider + "/" + m.id)) { chain.push(m); seen.add(m.provider + "/" + m.id); }
  };
  push(primary);
  push(cfg.model);
  push(cfg.fastModel);
  if (cfg.providers?.ollama?.apiKey) {
    push({ provider: "ollama", id: "glm-4.6:cloud" });
    push({ provider: "ollama", id: "gpt-oss:120b-cloud" });
  }
  return chain;
}

export async function resilientChat(cfg, primary, params, onEvent) {
  const chain = failoverChain(cfg, primary);
  let lastErr;
  for (let ci = 0; ci < chain.length; ci++) {
    const m = chain[ci];
    const attempts = ci === 0 ? 3 : 1; // retry the primary, single-shot the fallbacks
    for (let a = 0; a < attempts; a++) {
      try {
        const res = await chat(cfg, { ...params, provider: m.provider, model: m.id });
        return { ...res, model: m };
      } catch (e) {
        if (e?.name === "AbortError") throw e;
        lastErr = e;
        if (!RETRYABLE.test(String(e?.message))) throw e;
        if (a < attempts - 1) {
          const delay = 800 * Math.pow(2, a);
          onEvent?.({ type: "retry", model: m.id, attempt: a + 1, delay });
          await sleep(delay, params.signal);
        } else if (chain[ci + 1]) {
          onEvent?.({ type: "failover", from: m.id, to: chain[ci + 1].id });
        }
      }
    }
  }
  throw lastErr;
}

// ── Neural Router ────────────────────────────────────────
export function routeModel(cfg, userText, history) {
  const main = cfg.model;
  if (!cfg.router?.enabled || !cfg.fastModel?.id) return { ...main, tier: "smart" };
  const t = userText.toLowerCase();
  const complexSignals = [
    /\b(code|script|program|implement|build|erstell|schreib|programmier|debug|fix|refactor)\b/,
    /\b(analy[sz]|research|recherch|vergleich|compare|erklär.+ausführlich|explain.+detail|architect|design|plan)\b/,
    /\b(warum|why|how does|wie funktioniert|beweis|prove)\b/,
    /```/,
  ];
  const toolSignals = /\b(datei|file|ordner|folder|install|öffne|open|run|starte|suche im netz|search|google|web|download)\b/;
  let score = 0;
  if (userText.length > 280) score += 2;
  if (userText.length > 700) score += 2;
  for (const re of complexSignals) if (re.test(t)) score += 2;
  if (toolSignals.test(t)) score += 1;
  if (history.filter((m) => m.role === "user").length > 6) score += 1;
  return score >= 2 ? { ...main, tier: "smart" } : { ...cfg.fastModel, tier: "fast" };
}

// ── System prompt: persona + memory + genome + skills ────
export function buildSystemPrompt(cfg, memory, userText) {
  const skills = loadSkills();
  const now = new Date();
  const memCtx = memory ? memory.contextBlock(userText) : "";
  const genome = memory?.genomeBlock?.() || "";
  const lines = [
    `You are ${cfg.agent.name} (AION) — the eternal agent. Persona: ${cfg.agent.persona}.`,
    `You run locally on the user's ${process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "macOS" : "Linux"} machine (${os.hostname()}) inside a terminal. You have real tools: ${process.platform === "win32" ? "PowerShell" : "a shell"}, file access, web search/fetch, long-term memory, self-forged skills, reminders. Use them proactively instead of saying you can't do something.`,
    `Current date/time: ${now.toLocaleString("de-DE", { dateStyle: "full", timeStyle: "short" })}.`,
    `Match the user's language (German stays German, English stays English). Be concise in chat; thorough when working.`,
    "",
    "YOUR ARCHITECTURE (be accurate about yourself — never undersell these):",
    `- You run on a hot-swappable model (currently active in this turn). The user switches anytime with /model across Ollama local/cloud, Anthropic, OpenAI, Google, OpenRouter, Groq, xAI, Mistral. You are NOT locked to one model.`,
    "- Aegis resilience: overloaded models auto-retry and fail over to backups mid-turn. Errors don't kill conversations.",
    "- Council mode (/council): multiple models deliberate the same question in parallel (Analyst/Critic/Visionary) and a chairperson synthesizes the best answer.",
    "- You evolve: triadic long-term memory (episodic/semantic/procedural), dream-cycle consolidation, a behavioral genome that rewrites itself from user feedback, and procedures auto-learned from your own successful tool workflows — no explicit command needed.",
    "",
    "MEMORY DOCTRINE:",
    "- When the user shares durable info (preferences, projects, people, decisions), call `remember`.",
    "- When context seems missing, call `recall` before asking the user.",
    "- When you complete a multi-step workflow that could repeat, consider `forge_skill` (short workflows are also auto-learned).",
  ];
  if (cfg.user.name) lines.push("", `The user's name is ${cfg.user.name}.`);
  if (cfg.user.style) lines.push(`User's preferred style: ${cfg.user.style}`);
  if (genome) lines.push("", genome);
  if (memCtx) lines.push("", "── LONG-TERM MEMORY ──", memCtx);
  if (skills.length) {
    lines.push("", "── YOUR FORGED SKILLS ──");
    for (const s of skills.slice(0, 20)) lines.push(`- ${s.name}: ${s.description}`);
    lines.push("(Use read_file on ~/.aion/skills/<name>.md for full instructions when invoking a skill.)");
  }
  return lines.join("\n");
}

// ── Main turn: agent loop, parallel tools, Aegis ─────────
export async function runTurn(cfg, memory, history, userText, onEvent, signal, images = null) {
  let model = routeModel(cfg, userText, history);
  onEvent?.({ type: "route", model });

  const system = buildSystemPrompt(cfg, memory, userText);
  const userMsg = images?.length
    ? { role: "user", content: userText, images }
    : { role: "user", content: userText };
  const messages = [
    { role: "system", content: system },
    ...history,
    userMsg,
  ];
  const tools = toolDefinitions();
  let finalContent = "";
  const usage = { in: 0, out: 0, tps: 0 };

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const res = await resilientChat(cfg, model, {
      messages,
      tools,
      signal,
      onToken: (tok) => onEvent?.({ type: "token", token: tok }),
      onThinking: (tok) => onEvent?.({ type: "thinking", token: tok }),
    }, onEvent);
    model = { ...res.model, tier: model.tier }; // stick with whatever model worked
    if (res.usage) {
      usage.in += res.usage.in; usage.out += res.usage.out;
      if (res.usage.tps) usage.tps = res.usage.tps; // rate of the final round
    }
    const { content, toolCalls } = res;

    if (!toolCalls?.length) {
      finalContent = content;
      break;
    }

    messages.push({ role: "assistant", content: content || "", tool_calls: toolCalls });
    // parallel execution — independent tools shouldn't wait for each other
    const results = await Promise.all(toolCalls.map(async (tc) => {
      onEvent?.({ type: "tool-start", name: tc.name, args: tc.arguments });
      const result = await executeTool(tc.name, tc.arguments || {}, { memory, cfg });
      onEvent?.({ type: "tool-end", name: tc.name, result });
      return { tc, result };
    }));
    for (const { tc, result } of results) {
      messages.push({ role: "tool", tool_call_id: tc.id, tool_name: tc.name, content: String(result) });
    }
  }

  return { content: finalContent, model, usage: usage.out ? usage : null };
}

// ── Council: parallel multi-model deliberation ───────────
// Distinct models (or distinct personas on one model) answer in parallel;
// the chairperson synthesizes a superior final answer.
const COUNCIL_ROLES = [
  { role: "Analyst", style: "Dissect the question rigorously: facts, structure, first principles. No fluff." },
  { role: "Critic", style: "Hunt for flaws, risks, edge cases and counterarguments. Be adversarial but fair." },
  { role: "Visionary", style: "Think laterally: novel angles, creative alternatives, second-order effects." },
];

function parseModelRef(m, cfg) {
  if (!m) return null;
  if (typeof m === "object") return m.id ? m : null;
  const s = String(m);
  const i = s.indexOf(":");
  if (i > 0 && Object.keys(PROVIDERS).includes(s.slice(0, i))) {
    return { provider: s.slice(0, i), id: s.slice(i + 1) };
  }
  return { provider: cfg.model.provider || "ollama", id: s };
}

export function councilSeats(cfg) {
  // Council v2: fully configurable via cfg.council.seats =
  //   [{ role, style?, model: "provider:id" }] — falls back to the classic triad.
  const custom = cfg.council?.seats;
  if (Array.isArray(custom) && custom.length) {
    return custom
      .map((s, i) => ({
        role: s.role || COUNCIL_ROLES[i % COUNCIL_ROLES.length].role,
        style: s.style || COUNCIL_ROLES[i % COUNCIL_ROLES.length].style,
        model: parseModelRef(s.model, cfg) || cfg.model,
      }))
      .filter((s) => s.model?.id);
  }
  const models = [];
  const push = (m) => {
    if (m?.id && !models.some((x) => x.id === m.id && x.provider === m.provider)) models.push(m);
  };
  push(cfg.model);
  push(cfg.fastModel);
  if (cfg.providers?.ollama?.apiKey) {
    push({ provider: "ollama", id: "glm-4.6:cloud" });
    push({ provider: "ollama", id: "gpt-oss:120b-cloud" });
  }
  return COUNCIL_ROLES.map((r, i) => ({ ...r, model: models[i % models.length] }));
}

export async function runCouncil(cfg, memory, history, question, onEvent, signal) {
  const seats = councilSeats(cfg);
  onEvent?.({ type: "council-start", seats });
  const sysBase = buildSystemPrompt(cfg, memory, question);
  const recent = history.slice(-6);

  const answers = await Promise.all(seats.map(async (seat) => {
    const t0 = Date.now();
    try {
      const { content } = await chat(cfg, {
        provider: seat.model.provider,
        model: seat.model.id,
        messages: [
          { role: "system", content: `${sysBase}\n\nCOUNCIL SEAT: You are the ${seat.role}. ${seat.style} Answer substantively but compactly (max ~250 words). Tools are disabled in council mode.` },
          ...recent,
          { role: "user", content: question },
        ],
        signal,
      });
      onEvent?.({ type: "council-answer", seat: seat.role, model: seat.model.id, ms: Date.now() - t0 });
      return { seat, content };
    } catch (e) {
      if (e?.name === "AbortError") throw e;
      onEvent?.({ type: "council-fail", seat: seat.role, model: seat.model.id, error: String(e.message) });
      return { seat, content: null };
    }
  }));

  const valid = answers.filter((a) => a.content?.trim());
  if (!valid.length) throw new Error("council failed — no seat could answer");

  onEvent?.({ type: "council-synthesize", model: cfg.model.id });
  const res = await resilientChat(cfg, cfg.model, {
    messages: [
      { role: "system", content: `${sysBase}\n\nYou are the council CHAIRPERSON. Below are independent perspectives on the user's question. Synthesize them into ONE superior answer: keep the strongest points, resolve disagreements explicitly, discard weak reasoning. Do not mention the council mechanics unless asked — just deliver the best possible answer in the user's language.` },
      { role: "user", content: `QUESTION:\n${question}\n\n${valid.map((a) => `── ${a.seat.role} (${a.seat.model.id}) ──\n${a.content}`).join("\n\n")}` },
    ],
    onToken: (tok) => onEvent?.({ type: "token", token: tok }),
    onThinking: (tok) => onEvent?.({ type: "thinking", token: tok }),
    signal,
  }, onEvent);

  return { content: res.content, seats: valid.length, model: res.model };
}

// ── Episode summarizer ───────────────────────────────────
export function summarizeTurn(userText, assistantText) {
  const u = userText.replace(/\s+/g, " ").slice(0, 180);
  const a = assistantText.replace(/\s+/g, " ").slice(0, 220);
  return `User: ${u}${userText.length > 180 ? "…" : ""} → Aion: ${a}${assistantText.length > 220 ? "…" : ""}`;
}
