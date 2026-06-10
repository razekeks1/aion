// AION sessions — chat persistence across restarts (`aion --continue`).
// One JSON file per session in ~/.aion/sessions, pruned to the newest 30.
import fs from "node:fs";
import path from "node:path";
import { SESSIONS_DIR } from "./config.mjs";

const MAX_SESSIONS = 30;

export function newSessionId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${Math.random().toString(36).slice(2, 6)}`;
}

export function sessionPath(id) {
  return path.join(SESSIONS_DIR, `${id}.json`);
}

// history: [{role, content}] — the model-facing transcript
export function saveSession(id, history, meta = {}) {
  if (!history?.length) return;
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  const data = {
    id,
    updated: Date.now(),
    title: String(history.find((m) => m.role === "user")?.content || "session").slice(0, 80),
    turns: history.filter((m) => m.role === "user").length,
    history,
    ...meta,
  };
  fs.writeFileSync(sessionPath(id), JSON.stringify(data, null, 2), "utf8");
  pruneSessions();
}

export function listSessions() {
  try {
    return fs.readdirSync(SESSIONS_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try { return JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), "utf8")); }
        catch { return null; }
      })
      .filter((s) => s?.history?.length)
      .sort((a, b) => b.updated - a.updated);
  } catch {
    return [];
  }
}

export function loadLatestSession() {
  return listSessions()[0] || null;
}

export function loadSession(id) {
  try { return JSON.parse(fs.readFileSync(sessionPath(id), "utf8")); } catch { return null; }
}

function pruneSessions() {
  const all = listSessions();
  for (const s of all.slice(MAX_SESSIONS)) {
    try { fs.unlinkSync(sessionPath(s.id)); } catch {}
  }
}

// ── /export — conversation → Markdown ────────────────────
export function exportMarkdown(history, { agentName = "Aion", model = "" } = {}) {
  const lines = [
    `# ${agentName} — Conversation Export`,
    "",
    `> Exported ${new Date().toLocaleString()}${model ? ` · model: ${model}` : ""}`,
    "",
  ];
  for (const m of history) {
    if (m.role === "user") lines.push(`## 🧑 You`, "", m.content, "");
    else if (m.role === "assistant") lines.push(`## ✦ ${agentName}`, "", m.content, "");
  }
  return lines.join("\n");
}
