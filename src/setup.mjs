// AION setup wizard — Ollama first, then the whole model universe.
import { PROVIDERS, listOllamaModels, pingOllama } from "./providers.mjs";
import { saveConfig } from "./config.mjs";
import { gradient, violet, aqua, ok, warn, err, dim, bold, ask, askHidden, select, Spinner } from "./ui.mjs";

export async function runSetup(cfg, rl) {
  const rerun = !!cfg.setupComplete;
  console.log();
  console.log("  " + gradient("╔═╗ ╦ ╔═╗ ╔╗╔   S E T U P"));
  console.log(dim("  ────────────────────────────────────────────"));
  console.log(`  ${violet("◆")} ${rerun ? "Reconfigure your agent — Enter keeps the current value." : "Welcome. Let's wire up your eternal agent."}\n`);

  // ── Step 1: identity ──────────────────────────────────
  const nameHint = cfg.user.name ? dim(` (Enter = keep "${cfg.user.name}")`) : dim(" (name)");
  const name = await ask(rl, `  ${aqua("What should Aion call you?")}${nameHint} `);
  if (name) cfg.user.name = name;

  // ── Step 2: Ollama (the foundation) ───────────────────
  console.log(`\n  ${bold("Step 1 · Ollama")} ${dim("— your local + cloud foundation")}`);
  const o = cfg.providers.ollama;
  const ollamaOptions = [];
  if (o) {
    ollamaOptions.push({
      label: ok("Keep current") + dim(`  (${o.host || "cloud"}${o.apiKey ? " · API key ✓" : ""})`),
      value: "keep",
    });
  }
  ollamaOptions.push(
    { label: "Local Ollama" + dim("  (http://localhost:11434)"), value: "local" },
    { label: "Ollama Cloud" + dim("  (ollama.com, needs API key)"), value: "cloud" },
    { label: "Local + Cloud" + dim("  (local host, key unlocks :cloud models)"), value: "both" },
    { label: (o ? "Remove / skip Ollama" : "Skip Ollama") + dim("  (cloud providers only)"), value: "skip" },
  );
  const mode = await select(rl, "  How do you run Ollama?", ollamaOptions);
  if (mode.value === "skip" && o) delete cfg.providers.ollama;

  if (mode.value !== "skip" && mode.value !== "keep") {
    cfg.providers.ollama = cfg.providers.ollama || {};
    if (mode.value === "local" || mode.value === "both") {
      const host = await ask(rl, `  Ollama host ${dim("(Enter = http://localhost:11434)")}: `);
      cfg.providers.ollama.host = host || "http://localhost:11434";
    }
    if (mode.value === "cloud") cfg.providers.ollama.host = PROVIDERS.ollama.cloudHost;
    if (mode.value === "cloud" || mode.value === "both") {
      console.log(dim(`  Get a key at ${PROVIDERS.ollama.keyUrl}`));
      const key = await askHidden(rl, `  Ollama API key: `);
      if (key) cfg.providers.ollama.apiKey = key;
    }

    const sp = new Spinner("connecting to Ollama…").start();
    const alive = await pingOllama(cfg);
    sp.stop();
    if (alive) {
      console.log(`  ${ok("✔")} Ollama connected`);
    } else {
      console.log(`  ${warn("⚠")} Could not reach Ollama — config saved anyway. Start it and run ${aqua("/setup")} later.`);
    }
  }

  // ── Step 3: cloud providers (optional) ────────────────
  console.log(`\n  ${bold("Step 2 · Cloud providers")} ${dim("— optional, unlock more brains")}`);
  const configured = Object.keys(cfg.providers).filter((k) => k !== "ollama" && cfg.providers[k]?.apiKey);
  if (configured.length) {
    console.log(`  ${ok("✔")} configured: ` + configured.map((k) => aqua(PROVIDERS[k]?.label || k)).join(dim(" · ")));
  }
  for (;;) {
    const remaining = Object.entries(PROVIDERS)
      .filter(([k]) => k !== "ollama" && !cfg.providers[k]?.apiKey)
      .map(([k, v]) => ({ label: v.label, value: k, hint: v.keyUrl }));
    const removable = configured.filter((k) => cfg.providers[k]?.apiKey);
    if (!remaining.length && !removable.length) break;
    const pick = await select(rl, "  Add or remove a provider? ", [
      { label: dim("No — continue"), value: "" },
      ...remaining,
      ...removable.map((k) => ({ label: warn("Remove ") + (PROVIDERS[k]?.label || k), value: "rm:" + k })),
    ]);
    if (!pick.value) break;
    if (pick.value.startsWith("rm:")) {
      const k = pick.value.slice(3);
      delete cfg.providers[k];
      console.log(`  ${ok("✔")} ${PROVIDERS[k]?.label || k} removed`);
      continue;
    }
    const key = await askHidden(rl, `  ${PROVIDERS[pick.value].label} API key: `);
    if (key) {
      cfg.providers[pick.value] = { apiKey: key };
      console.log(`  ${ok("✔")} ${PROVIDERS[pick.value].label} added`);
    }
  }

  // ── Step 4: pick models ───────────────────────────────
  console.log(`\n  ${bold("Step 3 · Models")}`);
  const allModels = await collectModels(cfg);
  if (!allModels.length) {
    console.log(`  ${err("✖")} No models available. Configure Ollama or add an API key, then run aion again.`);
    cfg.setupComplete = false;
    saveConfig(cfg);
    return cfg;
  }
  const modelOpts = allModels.map(modelOption);
  if (cfg.model.id) modelOpts.unshift({ label: ok("Keep current: ") + cfg.model.id, value: "__keep__" });
  const main = await select(rl, "  Main model (your agent's brain):", modelOpts, { allowCustom: true });
  if (main.value !== "__keep__") {
    cfg.model = main.custom ? parseCustom(main.value, cfg) : { provider: main.value.provider, id: main.value.id };
  }

  // ── Step 5: neural router ─────────────────────────────
  const routerOpts = [];
  if (cfg.fastModel?.id) {
    routerOpts.push({ label: ok("Keep current") + dim(`  (${cfg.router.enabled ? "on" : "off"} → ${cfg.fastModel.id})`), value: "keep" });
  }
  routerOpts.push(
    { label: "Yes — pick a fast model", value: "yes" },
    { label: "No — always use main model", value: "no" },
  );
  const wantRouter = await select(rl, "  Enable Neural Router? " + dim("(simple turns → fast model = faster + cheaper)"), routerOpts);
  if (wantRouter.value === "yes") {
    const fast = await select(rl, "  Fast model:", allModels.map(modelOption), { allowCustom: true });
    cfg.fastModel = fast.custom ? parseCustom(fast.value, cfg) : { provider: fast.value.provider, id: fast.value.id };
    cfg.router.enabled = true;
  } else if (wantRouter.value === "no") {
    cfg.router.enabled = false;
  }

  // ── Step 6: Telegram (optional) ───────────────────────
  const tg = cfg.telegram;
  const tgOpts = [];
  if (tg?.userId) tgOpts.push({ label: ok("Keep current") + dim(`  (@${tg.botName || "bot"} → ${tg.username ? "@" + tg.username : "user " + tg.userId})`), value: "keep" });
  tgOpts.push(
    { label: (tg?.userId ? "Reconnect / change bot" : "Yes — connect a bot") + dim("  (token from @BotFather)"), value: "yes" },
    { label: tg?.userId ? warn("Disconnect Telegram") : dim("No — maybe later"), value: tg?.userId ? "rm" : "no" },
  );
  const wantTg = await select(rl, "  Connect Telegram? " + dim("(chat with Aion from your phone)"), tgOpts);
  if (wantTg.value === "yes") {
    const { runTelegramSetup } = await import("./telegram.mjs");
    await runTelegramSetup(cfg, rl);
  } else if (wantTg.value === "rm") {
    delete cfg.telegram;
    console.log(`  ${ok("✔")} Telegram disconnected`);
  }

  cfg.setupComplete = true;
  if (!rerun) cfg.tourPending = true; // feature tour only on the very first setup
  saveConfig(cfg);
  console.log(`\n  ${ok("✔ Setup complete.")} ${dim("Aion remembers everything from here on.")}\n`);
  return cfg;
}

// Gather every selectable model: live Ollama tags + cloud catalogs for configured keys
export async function collectModels(cfg) {
  const models = [];
  if (cfg.providers.ollama) {
    try {
      const live = await listOllamaModels(cfg);
      for (const m of live) models.push({ provider: "ollama", id: m.id, hint: "ollama · installed" });
    } catch { /* host down — fall back to catalog */ }
    if (cfg.providers.ollama.apiKey) {
      for (const m of PROVIDERS.ollama.catalog.filter((x) => x.id.includes("cloud"))) {
        if (!models.some((x) => x.id === m.id)) models.push({ provider: "ollama", id: m.id, hint: "ollama · " + m.hint });
      }
    }
  }
  for (const [key, def] of Object.entries(PROVIDERS)) {
    if (key === "ollama" || !cfg.providers[key]?.apiKey) continue;
    for (const m of def.catalog) models.push({ provider: key, id: m.id, hint: `${key} · ${m.hint}` });
  }
  return models;
}

const modelOption = (m) => ({ label: m.id, value: m, hint: m.hint });

function parseCustom(value, cfg) {
  // "provider:model" or bare model (assume ollama, else first configured provider)
  const idx = value.indexOf("/") === -1 ? value.indexOf(":") : -1;
  for (const p of Object.keys(PROVIDERS)) {
    if (value.startsWith(p + ":")) return { provider: p, id: value.slice(p.length + 1) };
  }
  const fallback = cfg.providers.ollama ? "ollama" : Object.keys(cfg.providers)[0];
  return { provider: fallback, id: value };
}
