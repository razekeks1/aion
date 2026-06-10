// AION tools — the agent's hands. Shell, files, web, memory, skills, reminders.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { SKILLS_DIR, AION_HOME } from "./config.mjs";

const REMINDERS_PATH = path.join(AION_HOME, "reminders.json");

export function toolDefinitions() {
  return [
    tool("run_shell", "Run a PowerShell command on the user's Windows machine and return stdout/stderr. Use for anything system-related: listing files, checking processes, git, installing things, opening apps.", {
      command: { type: "string", description: "The PowerShell command to run" },
    }, ["command"]),
    tool("read_file", "Read a text file from disk.", {
      path: { type: "string", description: "Absolute or relative file path" },
    }, ["path"]),
    tool("write_file", "Write/overwrite a text file on disk. Creates parent folders.", {
      path: { type: "string", description: "File path" },
      content: { type: "string", description: "Full file content" },
    }, ["path", "content"]),
    tool("list_dir", "List files and folders in a directory.", {
      path: { type: "string", description: "Directory path" },
    }, ["path"]),
    tool("web_search", "Search the web. Returns top results with titles, URLs and snippets.", {
      query: { type: "string", description: "Search query" },
    }, ["query"]),
    tool("web_fetch", "Fetch a URL and return its readable text content.", {
      url: { type: "string", description: "Full URL including https://" },
    }, ["url"]),
    tool("remember", "Save an important fact to long-term memory. Use when the user shares something worth remembering (preferences, projects, personal info, decisions).", {
      fact: { type: "string", description: "The fact, phrased as a standalone statement" },
      type: { type: "string", description: "user | world | project", enum: ["user", "world", "project"] },
      importance: { type: "number", description: "0.0–1.0, how important this is" },
    }, ["fact"]),
    tool("recall", "Search long-term memory for relevant facts, episodes and procedures.", {
      query: { type: "string", description: "What to search memory for" },
    }, ["query"]),
    tool("forge_skill", "Create a new reusable skill for yourself. Use when you notice a repeatable workflow worth automating. The skill becomes part of your permanent abilities.", {
      name: { type: "string", description: "kebab-case skill name" },
      description: { type: "string", description: "One line: when to use this skill" },
      instructions: { type: "string", description: "Detailed markdown instructions for executing the skill" },
    }, ["name", "description", "instructions"]),
    tool("set_reminder", "Set a reminder for the user. AION shows due reminders at session start.", {
      when: { type: "string", description: "ISO datetime or natural description, e.g. 2026-06-10T09:00" },
      text: { type: "string", description: "What to remind about" },
    }, ["when", "text"]),
  ];
}

function tool(name, description, properties, required) {
  return {
    type: "function",
    function: { name, description, parameters: { type: "object", properties, required } },
  };
}

// ── executor ─────────────────────────────────────────────
export async function executeTool(name, args, ctx) {
  try {
    switch (name) {
      case "run_shell": return await runShell(args.command);
      case "read_file": return readFileTool(args.path);
      case "write_file": return writeFileTool(args.path, args.content);
      case "list_dir": return listDirTool(args.path);
      case "web_search": return await webSearch(args.query);
      case "web_fetch": return await webFetch(args.url);
      case "remember": {
        const f = ctx.memory.addFact(args.fact, { type: args.type || "user", importance: args.importance ?? 0.7 });
        ctx.memory.persist();
        return `Saved to long-term memory: "${f.text}"`;
      }
      case "recall": {
        const hits = ctx.memory.recall(args.query, 8);
        if (!hits.length) return "No relevant memories found.";
        return hits.map((h) => `[${h.kind}] ${h.text}`).join("\n");
      }
      case "forge_skill": return forgeSkill(args.name, args.description, args.instructions);
      case "set_reminder": return setReminder(args.when, args.text);
      default: return `Unknown tool: ${name}`;
    }
  } catch (e) {
    return `Tool error (${name}): ${e.message}`;
  }
}

function runShell(command) {
  return new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command],
      { timeout: 60000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        let out = "";
        if (stdout) out += stdout;
        if (stderr) out += (out ? "\n" : "") + "[stderr] " + stderr;
        if (error && !stdout && !stderr) out = `[error] ${error.message}`;
        resolve(truncate(out || "(no output)", 12000));
      });
  });
}

function readFileTool(p) {
  const data = fs.readFileSync(p, "utf8");
  return truncate(data, 24000);
}

function writeFileTool(p, content) {
  fs.mkdirSync(path.dirname(path.resolve(p)), { recursive: true });
  fs.writeFileSync(p, content, "utf8");
  return `Wrote ${Buffer.byteLength(content)} bytes to ${p}`;
}

function listDirTool(p) {
  const entries = fs.readdirSync(p || ".", { withFileTypes: true });
  return entries.map((e) => (e.isDirectory() ? "📁 " : "📄 ") + e.name).join("\n") || "(empty)";
}

// ── web ──────────────────────────────────────────────────
async function webSearch(query) {
  const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AION/1.0" },
    signal: AbortSignal.timeout(12000),
  });
  const html = await res.text();
  const results = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/g;
  let m;
  while ((m = re.exec(html)) && results.length < 6) {
    let url = m[1];
    const uddg = url.match(/uddg=([^&]+)/);
    if (uddg) url = decodeURIComponent(uddg[1]);
    results.push(`• ${strip(m[2])}\n  ${url}\n  ${strip(m[3] || "").slice(0, 200)}`);
  }
  return results.length ? results.join("\n\n") : "No results found.";
}

async function webFetch(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AION/1.0" },
    signal: AbortSignal.timeout(15000),
    redirect: "follow",
  });
  const type = res.headers.get("content-type") || "";
  const body = await res.text();
  if (type.includes("json")) return truncate(body, 16000);
  return truncate(strip(body
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
  ), 16000);
}

function strip(html) {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// ── skills ───────────────────────────────────────────────
export function forgeSkill(name, description, instructions) {
  const slug = name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug) return "Invalid skill name.";
  fs.mkdirSync(SKILLS_DIR, { recursive: true });
  const file = path.join(SKILLS_DIR, `${slug}.md`);
  fs.writeFileSync(file, `---\nname: ${slug}\ndescription: ${description}\nforged: ${new Date().toISOString()}\n---\n\n${instructions}\n`, "utf8");
  return `Skill "${slug}" forged and saved. It is now part of your permanent abilities.`;
}

export function loadSkills() {
  try {
    const files = fs.readdirSync(SKILLS_DIR).filter((f) => f.endsWith(".md"));
    return files.map((f) => {
      const raw = fs.readFileSync(path.join(SKILLS_DIR, f), "utf8");
      const name = raw.match(/^name:\s*(.+)$/m)?.[1] || f.replace(".md", "");
      const description = raw.match(/^description:\s*(.+)$/m)?.[1] || "";
      const body = raw.replace(/^---[\s\S]*?---\s*/, "");
      return { name, description, body, file: f };
    });
  } catch {
    return [];
  }
}

// ── reminders ────────────────────────────────────────────
function loadReminders() {
  try { return JSON.parse(fs.readFileSync(REMINDERS_PATH, "utf8")); } catch { return []; }
}

function setReminder(when, text) {
  const list = loadReminders();
  list.push({ id: Math.random().toString(36).slice(2, 8), when, text, created: Date.now() });
  fs.writeFileSync(REMINDERS_PATH, JSON.stringify(list, null, 2), "utf8");
  return `Reminder set for ${when}: "${text}"`;
}

export function dueReminders() {
  const list = loadReminders();
  const now = Date.now();
  const due = [], rest = [];
  for (const r of list) {
    const t = Date.parse(r.when);
    if (!isNaN(t) && t <= now) due.push(r);
    else rest.push(r);
  }
  if (due.length) fs.writeFileSync(REMINDERS_PATH, JSON.stringify(rest, null, 2), "utf8");
  return { due, pending: rest };
}

const truncate = (s, n) => (s.length > n ? s.slice(0, n) + `\n…[truncated ${s.length - n} chars]` : s);
