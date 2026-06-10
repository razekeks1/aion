// AION config — lives in %USERPROFILE%\.aion
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// AION_HOME env var overrides the data directory (used by tests & portable installs)
export const AION_HOME = process.env.AION_HOME || path.join(os.homedir(), ".aion");
export const CONFIG_PATH = path.join(AION_HOME, "config.json");
export const MEMORY_DIR = path.join(AION_HOME, "memory");
export const SKILLS_DIR = path.join(AION_HOME, "skills");
export const SESSIONS_DIR = path.join(AION_HOME, "sessions");

export const DEFAULT_CONFIG = {
  version: 1,
  user: { name: "", style: "" },
  agent: { name: "Aion", persona: "sharp, warm, direct — a brilliant companion that grows with its user" },
  providers: {
    // ollama: { host: "http://localhost:11434", apiKey: "" }
    // openai: { apiKey: "" }, anthropic: { apiKey: "" }, google: { apiKey: "" },
    // openrouter: { apiKey: "" }, groq: { apiKey: "" }, xai: { apiKey: "" }
  },
  model: { provider: "", id: "" },        // main model
  fastModel: { provider: "", id: "" },     // router target for simple turns
  router: { enabled: false },
  // Council v2 — custom seats, e.g. [{ role: "Skeptic", style: "…", model: "ollama:glm-4.6:cloud" }]
  council: { seats: [] },
  memory: { enabled: true, dreamOnExit: true, maxRecall: 6 },
  setupComplete: false,
};

export function ensureDirs() {
  for (const d of [AION_HOME, MEMORY_DIR, SKILLS_DIR, SESSIONS_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

export function loadConfig() {
  ensureDirs();
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    return deepMerge(structuredClone(DEFAULT_CONFIG), raw);
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

export function saveConfig(cfg) {
  ensureDirs();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf8");
}

function deepMerge(base, over) {
  for (const k of Object.keys(over || {})) {
    if (over[k] && typeof over[k] === "object" && !Array.isArray(over[k]) && typeof base[k] === "object" && base[k]) {
      deepMerge(base[k], over[k]);
    } else {
      base[k] = over[k];
    }
  }
  return base;
}
