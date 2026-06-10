// AION provider layer — unified streaming chat across Ollama + every major cloud
// Two wire protocols cover everything:
//   1. Ollama native  (/api/chat, NDJSON streaming)
//   2. OpenAI-compatible (/chat/completions, SSE) — OpenAI, Anthropic, Google,
//      OpenRouter, Groq, xAI, Mistral all expose this surface.

export const PROVIDERS = {
  ollama: {
    label: "Ollama (local / cloud)",
    kind: "ollama",
    defaultHost: "http://localhost:11434",
    cloudHost: "https://ollama.com",
    keyUrl: "https://ollama.com/settings/keys",
    catalog: [
      { id: "gpt-oss:120b-cloud", hint: "OpenAI open-weights, via Ollama Cloud" },
      { id: "gpt-oss:20b-cloud", hint: "fast cloud" },
      { id: "deepseek-v3.1:671b-cloud", hint: "frontier-class, via Ollama Cloud" },
      { id: "qwen3-coder:480b-cloud", hint: "coding, via Ollama Cloud" },
      { id: "kimi-k2:1t-cloud", hint: "1T MoE, via Ollama Cloud" },
      { id: "glm-4.6:cloud", hint: "agentic, via Ollama Cloud" },
      { id: "llama3.1:8b", hint: "local — light & solid" },
      { id: "qwen3:8b", hint: "local — strong reasoning" },
      { id: "qwen3:30b", hint: "local — MoE, fast for its size" },
      { id: "gemma3:12b", hint: "local — Google open model" },
    ],
  },
  anthropic: {
    label: "Anthropic (Claude)",
    kind: "openai",
    base: "https://api.anthropic.com/v1",
    keyUrl: "https://console.anthropic.com/settings/keys",
    catalog: [
      { id: "claude-opus-4-8", hint: "most capable" },
      { id: "claude-sonnet-4-6", hint: "balanced flagship" },
      { id: "claude-haiku-4-5-20251001", hint: "fast & cheap" },
    ],
  },
  openai: {
    label: "OpenAI",
    kind: "openai",
    base: "https://api.openai.com/v1",
    keyUrl: "https://platform.openai.com/api-keys",
    catalog: [
      { id: "gpt-5.2", hint: "flagship" },
      { id: "gpt-5.2-mini", hint: "fast" },
      { id: "gpt-4.1", hint: "previous gen" },
    ],
  },
  google: {
    label: "Google (Gemini)",
    kind: "openai",
    base: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyUrl: "https://aistudio.google.com/apikey",
    catalog: [
      { id: "gemini-3-pro", hint: "flagship" },
      { id: "gemini-3-flash", hint: "fast" },
      { id: "gemini-2.5-flash", hint: "cheap workhorse" },
    ],
  },
  openrouter: {
    label: "OpenRouter (400+ models)",
    kind: "openai",
    base: "https://openrouter.ai/api/v1",
    keyUrl: "https://openrouter.ai/keys",
    catalog: [
      { id: "anthropic/claude-sonnet-4.6", hint: "Claude via OR" },
      { id: "openai/gpt-5.2", hint: "GPT via OR" },
      { id: "deepseek/deepseek-chat-v3.1", hint: "cheap frontier" },
      { id: "meta-llama/llama-4-maverick", hint: "open weights" },
    ],
  },
  groq: {
    label: "Groq (ultra-fast inference)",
    kind: "openai",
    base: "https://api.groq.com/openai/v1",
    keyUrl: "https://console.groq.com/keys",
    catalog: [
      { id: "llama-3.3-70b-versatile", hint: "fast + smart" },
      { id: "qwen/qwen3-32b", hint: "reasoning" },
    ],
  },
  xai: {
    label: "xAI (Grok)",
    kind: "openai",
    base: "https://api.x.ai/v1",
    keyUrl: "https://console.x.ai",
    catalog: [
      { id: "grok-4", hint: "flagship" },
      { id: "grok-4-fast", hint: "fast" },
    ],
  },
  mistral: {
    label: "Mistral",
    kind: "openai",
    base: "https://api.mistral.ai/v1",
    keyUrl: "https://console.mistral.ai/api-keys",
    catalog: [
      { id: "mistral-large-latest", hint: "flagship" },
      { id: "mistral-small-latest", hint: "fast" },
    ],
  },
};

function ollamaBase(cfg) {
  const p = cfg.providers.ollama || {};
  if (p.apiKey && (!p.host || p.host === PROVIDERS.ollama.cloudHost)) return PROVIDERS.ollama.cloudHost;
  return p.host || PROVIDERS.ollama.defaultHost;
}

function ollamaHeaders(cfg) {
  const h = { "Content-Type": "application/json" };
  const key = cfg.providers.ollama?.apiKey;
  if (key) h["Authorization"] = `Bearer ${key}`;
  return h;
}

// ── list locally available / cloud models from an Ollama host ──
export async function listOllamaModels(cfg) {
  const base = ollamaBase(cfg);
  const res = await fetch(`${base}/api/tags`, { headers: ollamaHeaders(cfg), signal: AbortSignal.timeout(7000) });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (data.models || []).map((m) => ({ id: m.name, size: m.size }));
}

export async function pingOllama(cfg) {
  try {
    const base = ollamaBase(cfg);
    const res = await fetch(`${base}/api/version`, { headers: ollamaHeaders(cfg), signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}

// ── unified chat ────────────────────────────────────────────
// chat(cfg, { provider, model, messages, tools, onToken }) →
//   { content, toolCalls: [{id, name, arguments}], usage }
export async function chat(cfg, { provider, model, messages, tools, onToken, onThinking, signal }) {
  const def = PROVIDERS[provider];
  if (!def) throw new Error(`Unknown provider: ${provider}`);
  if (def.kind === "ollama") return chatOllama(cfg, { model, messages, tools, onToken, onThinking, signal });
  return chatOpenAI(cfg, def, provider, { model, messages, tools, onToken, onThinking, signal });
}

async function chatOllama(cfg, { model, messages, tools, onToken, onThinking, signal }) {
  const base = ollamaBase(cfg);
  const body = { model, messages: toOllamaMessages(messages), stream: true };
  if (tools?.length) body.tools = tools;
  const res = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: ollamaHeaders(cfg),
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${(await res.text()).slice(0, 300)}`);

  let content = "";
  const toolCalls = [];
  let usage = null;
  let buf = "";
  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      if (obj.error) throw new Error(`Ollama: ${obj.error}`);
      if (obj.done && obj.eval_count) {
        usage = {
          in: obj.prompt_eval_count || 0,
          out: obj.eval_count || 0,
          tps: obj.eval_duration ? Math.round(obj.eval_count / (obj.eval_duration / 1e9)) : 0,
        };
      }
      const msg = obj.message || {};
      if (msg.thinking) onThinking?.(msg.thinking);
      if (msg.content) { content += msg.content; onToken?.(msg.content); }
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          toolCalls.push({
            id: tc.id || `call_${toolCalls.length}`,
            name: tc.function?.name,
            arguments: tc.function?.arguments ?? {},
          });
        }
      }
    }
  }
  return { content, toolCalls, usage };
}

async function chatOpenAI(cfg, def, providerName, { model, messages, tools, onToken, onThinking, signal }) {
  const apiKey = cfg.providers[providerName]?.apiKey;
  if (!apiKey) throw new Error(`No API key configured for ${providerName}. Run /setup.`);
  const body = { model, messages: toOpenAIMessages(messages), stream: true };
  if (tools?.length) body.tools = tools;
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
  if (providerName === "openrouter") {
    headers["HTTP-Referer"] = "https://github.com/aion-agent";
    headers["X-Title"] = "AION";
  }
  const res = await fetch(`${def.base}/chat/completions`, {
    method: "POST", headers, body: JSON.stringify(body), signal,
  });
  if (!res.ok) throw new Error(`${providerName} ${res.status}: ${(await res.text()).slice(0, 300)}`);

  let content = "";
  let usage = null;
  const tcParts = new Map(); // index → {id, name, args}
  let buf = "";
  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") continue;
      let obj;
      try { obj = JSON.parse(payload); } catch { continue; }
      if (obj.usage?.completion_tokens) {
        usage = { in: obj.usage.prompt_tokens || 0, out: obj.usage.completion_tokens, tps: 0 };
      }
      const delta = obj.choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.reasoning_content || delta.reasoning) onThinking?.(delta.reasoning_content || delta.reasoning);
      if (delta.content) { content += delta.content; onToken?.(delta.content); }
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          if (!tcParts.has(idx)) tcParts.set(idx, { id: tc.id || `call_${idx}`, name: "", args: "" });
          const part = tcParts.get(idx);
          if (tc.id) part.id = tc.id;
          if (tc.function?.name) part.name += tc.function.name;
          if (tc.function?.arguments) part.args += tc.function.arguments;
        }
      }
    }
  }
  const toolCalls = [...tcParts.values()].map((p) => {
    let args = {};
    try { args = JSON.parse(p.args || "{}"); } catch {}
    return { id: p.id, name: p.name, arguments: args };
  });
  return { content, toolCalls, usage };
}

// internal messages → Ollama wire format (tool calls/results must be re-shaped)
function toOllamaMessages(messages) {
  return messages.map((m) => {
    if (m.role === "tool") {
      return { role: "tool", tool_name: m.tool_name || "tool", content: String(m.content ?? "") };
    }
    if (m.role === "assistant" && m.tool_calls) {
      return {
        role: "assistant",
        content: m.content || "",
        tool_calls: m.tool_calls.map((tc) => ({
          function: { name: tc.name, arguments: tc.arguments ?? {} },
        })),
      };
    }
    return { role: m.role, content: m.content };
  });
}

// internal messages → OpenAI wire format (tool results etc.)
function toOpenAIMessages(messages) {
  return messages.map((m) => {
    if (m.role === "tool") {
      return { role: "tool", tool_call_id: m.tool_call_id || m.tool_name || "call_0", content: m.content };
    }
    if (m.role === "assistant" && m.tool_calls) {
      return {
        role: "assistant",
        content: m.content || null,
        tool_calls: m.tool_calls.map((tc, i) => ({
          id: tc.id || `call_${i}`,
          type: "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments ?? {}) },
        })),
      };
    }
    return { role: m.role, content: m.content };
  });
}

// Quick non-streaming helper for internal calls (dreams, routing, summaries)
export async function quickChat(cfg, { provider, model, system, prompt, maxLen = 4000 }) {
  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: prompt.slice(0, 24000) });
  const { content } = await chat(cfg, { provider, model, messages });
  return content.slice(0, maxLen);
}
