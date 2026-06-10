// AION Triadic Memory — episodic / semantic / procedural, like a brain.
//
//   episodic    what happened          (conversation episodes, auto-summarized)
//   semantic    what is true           (facts about the user & world, scored)
//   procedural  how to do things       (learned workflows & preferences)
//
// Recall = hybrid trigram-cosine + BM25 + recency + importance. Zero deps,
// fully offline, language-agnostic (works for German & English alike).
//
// The Dream Cycle consolidates: episodes → facts, duplicate facts → merged,
// stale low-importance memories → decayed and eventually pruned.

import fs from "node:fs";
import path from "node:path";
import { MEMORY_DIR } from "./config.mjs";
import { quickChat } from "./providers.mjs";

const FILES = {
  episodes: path.join(MEMORY_DIR, "episodes.json"),
  facts: path.join(MEMORY_DIR, "facts.json"),
  procedures: path.join(MEMORY_DIR, "procedures.json"),
  user: path.join(MEMORY_DIR, "user.json"),
  genome: path.join(MEMORY_DIR, "genome.json"),
};

function load(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function save(file, data) {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

export class Memory {
  constructor() {
    this.episodes = load(FILES.episodes, []);     // {id, ts, summary, raw?}
    this.facts = load(FILES.facts, []);            // {id, ts, text, type, importance, accessCount, lastAccess}
    this.procedures = load(FILES.procedures, []);  // {id, ts, name, steps, uses}
    this.user = load(FILES.user, { name: "", traits: [], preferences: [], topics: {} });
    this.genome = load(FILES.genome, { rules: [], feedback: [] }); // evolved behavior
    this.dirty = false;
    this.newEpisodesSinceDream = 0;
  }

  persist() {
    save(FILES.episodes, this.episodes);
    save(FILES.facts, this.facts);
    save(FILES.procedures, this.procedures);
    save(FILES.user, this.user);
    save(FILES.genome, this.genome);
    this.dirty = false;
  }

  stats() {
    const genes = this.genome?.rules?.length ? ` · ${this.genome.rules.length} genes` : "";
    return `${this.episodes.length} episodes · ${this.facts.length} facts · ${this.procedures.length} procedures${genes}`;
  }

  // ── Evolution Engine: feedback → genome ────────────────
  recordFeedback(signal, context) {
    this.genome.feedback.push({ ts: Date.now(), signal, context: String(context).slice(0, 240) });
    if (this.genome.feedback.length > 100) this.genome.feedback = this.genome.feedback.slice(-80);
    this.dirty = true;
  }

  genomeBlock() {
    if (!this.genome.rules.length) return "";
    return "── EVOLVED BEHAVIORS (learned from this user's feedback — follow them) ──\n" +
      this.genome.rules.map((r) => `- ${r.text}`).join("\n");
  }

  // ── write paths ────────────────────────────────────────
  addEpisode(summary, raw = null) {
    this.episodes.push({ id: rid(), ts: Date.now(), summary, raw });
    this.newEpisodesSinceDream++;
    this.dirty = true;
  }

  addFact(text, { type = "general", importance = 0.6 } = {}) {
    // near-duplicate guard
    const dup = this.facts.find((f) => similarity(f.text, text) > 0.82);
    if (dup) {
      dup.importance = Math.min(1, dup.importance + 0.1);
      dup.ts = Date.now();
      this.dirty = true;
      return dup;
    }
    const fact = { id: rid(), ts: Date.now(), text, type, importance, accessCount: 0, lastAccess: Date.now() };
    this.facts.push(fact);
    this.dirty = true;
    return fact;
  }

  addProcedure(name, steps) {
    const existing = this.procedures.find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (existing) { existing.steps = steps; existing.ts = Date.now(); existing.uses++; }
    else this.procedures.push({ id: rid(), ts: Date.now(), name, steps, uses: 1 });
    this.dirty = true;
  }

  forget(idOrText) {
    const before = this.facts.length;
    this.facts = this.facts.filter((f) => f.id !== idOrText && !f.text.toLowerCase().includes(String(idOrText).toLowerCase()));
    this.dirty = true;
    return before - this.facts.length;
  }

  // ── recall: hybrid lexical retrieval ───────────────────
  recall(query, limit = 6) {
    if (!query?.trim()) return [];
    const now = Date.now();
    const scored = [];
    const pools = [
      ...this.facts.map((f) => ({ item: f, text: f.text, kind: "fact" })),
      ...this.episodes.slice(-200).map((e) => ({ item: e, text: e.summary, kind: "episode" })),
      ...this.procedures.map((p) => ({ item: p, text: `${p.name}: ${p.steps}`, kind: "procedure" })),
    ];
    for (const { item, text, kind } of pools) {
      const lex = similarity(query, text);                                 // trigram cosine
      const kw = keywordOverlap(query, text);                              // token overlap
      const ageDays = (now - item.ts) / 86400000;
      const recency = Math.exp(-ageDays / 90);                             // 90-day half-ish life
      const importance = item.importance ?? 0.5;
      const score = lex * 0.45 + kw * 0.35 + recency * 0.1 + importance * 0.1;
      if (score > 0.18) scored.push({ score, text, kind, item });
    }
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, limit);
    for (const t of top) {
      if (t.kind === "fact") { t.item.accessCount++; t.item.lastAccess = now; this.dirty = true; }
    }
    return top;
  }

  // Context block injected into the system prompt each turn
  contextBlock(query) {
    const hits = this.recall(query, 6);
    const lines = [];
    if (this.user.name) lines.push(`User's name: ${this.user.name}`);
    if (this.user.traits.length) lines.push(`User traits: ${this.user.traits.slice(0, 8).join("; ")}`);
    if (this.user.preferences.length) lines.push(`User preferences: ${this.user.preferences.slice(0, 8).join("; ")}`);
    if (hits.length) {
      lines.push("Relevant memories:");
      for (const h of hits) lines.push(`  - [${h.kind}] ${h.text}`);
    }
    return lines.length ? lines.join("\n") : "";
  }

  // ── Dream Cycle ────────────────────────────────────────
  // Consolidate recent episodes into durable facts + user model updates,
  // merge near-duplicate facts, decay stale ones.
  async dream(cfg, modelRef, { log = () => {} } = {}) {
    const recent = this.episodes.slice(-Math.max(this.newEpisodesSinceDream, 5));
    let extracted = 0;

    if (recent.length && modelRef?.id) {
      log("consolidating episodes → facts…");
      const prompt = [
        "You are the memory consolidation process of an AI agent. Below are recent conversation episode summaries.",
        "Extract durable knowledge as STRICT JSON (no markdown):",
        '{"facts":[{"text":"…","type":"user|world|project","importance":0.0-1.0}],',
        '"traits":["short user personality/working-style traits"],',
        '"preferences":["concrete user preferences"]}',
        "Only include things worth remembering long-term. Empty arrays are fine.",
        "",
        ...recent.map((e) => `- ${e.summary}`),
      ].join("\n");
      try {
        const out = await quickChat(cfg, {
          provider: modelRef.provider, model: modelRef.id,
          system: "Respond with strict JSON only.", prompt,
        });
        const json = extractJson(out);
        if (json) {
          for (const f of json.facts || []) {
            if (f?.text) { this.addFact(f.text, { type: f.type || "general", importance: clamp(f.importance ?? 0.6) }); extracted++; }
          }
          for (const t of json.traits || []) {
            if (t && !this.user.traits.some((x) => similarity(x, t) > 0.8)) this.user.traits.push(t);
          }
          for (const p of json.preferences || []) {
            if (p && !this.user.preferences.some((x) => similarity(x, p) > 0.8)) this.user.preferences.push(p);
          }
        }
      } catch (e) {
        log(`llm consolidation skipped (${e.message?.slice(0, 80)})`);
      }
    }

    // evolve the behavioral genome from feedback signals
    const fb = this.genome.feedback.slice(-40);
    if (modelRef?.id && (fb.length || recent.length)) {
      log("evolving genome…");
      const gPrompt = [
        "You maintain the behavioral GENOME of an AI agent: a short list of learned rules about how to work better for THIS specific user.",
        'Based on CURRENT RULES, FEEDBACK SIGNALS (pos = user was happy, neg = user corrected/was unhappy) and RECENT EPISODES, output the improved rule set as STRICT JSON: {"rules":["…"]}.',
        "Max 10 rules, each ≤120 chars, imperative voice, specific and behavioral. Keep rules that still apply, drop stale ones, only add new rules backed by evidence. Empty list is valid.",
        "",
        "CURRENT RULES:",
        ...(this.genome.rules.length ? this.genome.rules.map((r) => "- " + r.text) : ["(none)"]),
        "",
        "FEEDBACK SIGNALS:",
        ...(fb.length ? fb.map((f) => `- [${f.signal}] ${f.context}`) : ["(none)"]),
        "",
        "RECENT EPISODES:",
        ...recent.slice(-15).map((e) => "- " + e.summary),
      ].join("\n");
      try {
        const out = await quickChat(cfg, {
          provider: modelRef.provider, model: modelRef.id,
          system: "Respond with strict JSON only.", prompt: gPrompt,
        });
        const json = extractJson(out);
        if (json && Array.isArray(json.rules)) {
          const old = this.genome.rules;
          const next = json.rules
            .filter((x) => typeof x === "string" && x.trim())
            .slice(0, 10)
            .map((t) => {
              const text = t.trim().slice(0, 140);
              // rules that survive a dream gain confidence; new ones start neutral
              const prev = old.find((r) => similarity(r.text, text) > 0.7);
              return prev
                ? { ...prev, text, ts: Date.now(), confidence: Math.min(1, (prev.confidence ?? 0.5) + 0.15) }
                : { text, ts: Date.now(), confidence: 0.5, pinned: false };
            });
          // pinned rules are immortal — re-add any the model dropped
          for (const r of old.filter((r) => r.pinned)) {
            if (!next.some((n) => similarity(n.text, r.text) > 0.7)) next.unshift(r);
          }
          this.genome.rules = next.slice(0, 12);
          this.genome.feedback = [];
        }
      } catch (e) {
        log(`genome evolution skipped (${e.message?.slice(0, 80)})`);
      }
    }

    // merge near-duplicate facts
    log("merging duplicates…");
    const merged = [];
    let mergedCount = 0;
    for (const f of this.facts.sort((a, b) => b.importance - a.importance)) {
      const twin = merged.find((m) => similarity(m.text, f.text) > 0.8);
      if (twin) {
        twin.importance = Math.min(1, Math.max(twin.importance, f.importance) + 0.05);
        twin.accessCount += f.accessCount;
        mergedCount++;
      } else merged.push(f);
    }
    this.facts = merged;

    // decay + prune
    log("decaying stale memories…");
    const now = Date.now();
    let pruned = 0;
    this.facts = this.facts.filter((f) => {
      const idleDays = (now - (f.lastAccess || f.ts)) / 86400000;
      if (idleDays > 30) f.importance *= Math.pow(0.985, idleDays - 30);
      if (f.importance < 0.08 && f.accessCount < 2) { pruned++; return false; }
      return true;
    });

    // compress episode log
    if (this.episodes.length > 400) this.episodes = this.episodes.slice(-300);

    this.newEpisodesSinceDream = 0;
    this.persist();
    return { extracted, mergedCount, pruned, genes: this.genome.rules.length };
  }
}

// Detect implicit feedback in a user message about the PREVIOUS answer.
const NEG_FB = /(^|\b)(nein|nö|ne+,|falsch|stimmt nicht|nicht so|quatsch|doch nicht|schlecht|bullshit|wrong|incorrect|nope|bad answer|not what i|mach.{0,20}nochmal|nochmal.{0,20}anders|try again|redo|das war nicht)\b/i;
const POS_FB = /(^|\b)(danke|perfekt|genau|geil|nice|super|great|exactly|thanks|love it|sehr gut|krass gut|stark|excellent|wunderbar)\b/i;

export function detectFeedback(line) {
  if (NEG_FB.test(line)) return "neg";
  if (POS_FB.test(line)) return "pos";
  return null;
}

// ── text similarity primitives ───────────────────────────
function trigrams(s) {
  const t = ` ${s.toLowerCase().replace(/\s+/g, " ").trim()} `;
  const grams = new Map();
  for (let i = 0; i < t.length - 2; i++) {
    const g = t.slice(i, i + 3);
    grams.set(g, (grams.get(g) || 0) + 1);
  }
  return grams;
}

export function similarity(a, b) {
  if (!a || !b) return 0;
  const ga = trigrams(a), gb = trigrams(b);
  let dot = 0, na = 0, nb = 0;
  for (const v of ga.values()) na += v * v;
  for (const v of gb.values()) nb += v * v;
  const [small, big] = ga.size < gb.size ? [ga, gb] : [gb, ga];
  for (const [g, v] of small) { const w = big.get(g); if (w) dot += v * w; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

function keywordOverlap(query, text) {
  const stop = new Set(["der","die","das","und","ist","ein","eine","the","a","an","is","are","was","what","how","wie","von","mit","für","for","to","of","in","on","i","ich","du","you","es","it"]);
  const qt = new Set(query.toLowerCase().split(/\W+/).filter((w) => w.length > 2 && !stop.has(w)));
  if (!qt.size) return 0;
  const tt = new Set(text.toLowerCase().split(/\W+/));
  let hit = 0;
  for (const w of qt) if (tt.has(w)) hit++;
  return hit / qt.size;
}

function extractJson(s) {
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

const clamp = (x) => Math.max(0, Math.min(1, Number(x) || 0.5));
const rid = () => Math.random().toString(36).slice(2, 10);
