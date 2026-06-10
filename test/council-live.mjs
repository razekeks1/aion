// Live council test against the user's real config. Short question, cheap.
import { loadConfig } from "../src/config.mjs";
import { runCouncil } from "../src/agent.mjs";
import { Memory } from "../src/memory.mjs";

const cfg = loadConfig();
if (!cfg.setupComplete) { console.log("setup not complete — skipping"); process.exit(0); }

const memory = new Memory();
const t0 = Date.now();
const { content, seats, model } = await runCouncil(cfg, memory, [],
  "In einem Satz: Was ist der größte Vorteil lokaler KI-Agenten?",
  (ev) => {
    if (ev.type === "council-start") console.log("seats:", ev.seats.map((s) => `${s.role}@${s.model.id}`).join(", "));
    if (ev.type === "council-answer") console.log(`  ✓ ${ev.seat} (${ev.model}) ${ev.ms}ms`);
    if (ev.type === "council-fail") console.log(`  ✖ ${ev.seat} (${ev.model}): ${ev.error.slice(0, 80)}`);
    if (ev.type === "council-synthesize") console.log("  synthesizing via", ev.model);
    if (ev.type === "failover") console.log(`  ⚡ failover ${ev.from} → ${ev.to}`);
  });
console.log(`\nFINAL (${seats} seats, ${model.id}, ${Date.now() - t0}ms):\n${content.slice(0, 400)}`);
