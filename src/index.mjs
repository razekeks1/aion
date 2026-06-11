// AION entry — `aion` in any terminal.
import { createRequire } from "node:module";
import { loadConfig, saveConfig, ensureDirs } from "./config.mjs";
import { runSetup } from "./setup.mjs";
import { runRepl } from "./repl.mjs";
import { runTurn } from "./agent.mjs";
import { Memory } from "./memory.mjs";
import { loadLatestSession, newSessionId, saveSession } from "./sessions.mjs";
import { createInterface, gradient, dim } from "./ui.mjs";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

export async function main(argv) {
  ensureDirs();
  let cfg = loadConfig();

  // ── flags ──────────────────────────────────────────────
  if (argv.includes("--version") || argv.includes("-v")) {
    console.log(`aion v${version}`);
    return;
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log([
      "",
      "  " + gradient("AION — the eternal agent"),
      "",
      "  aion              start interactive session (runs setup on first launch)",
      "  aion --continue   resume your last conversation",
      "  aion setup        re-run the setup wizard (keeps current settings)",
      '  aion -p "..."     one-shot prompt (prints answer, exits)',
      "  aion telegram     listen for Telegram messages",
      "                    (setup|start|stop|status|install|uninstall)",
      "  aion --version    print version",
      "",
      "  data lives in " + dim(process.platform === "win32" ? "%USERPROFILE%\\.aion" : "~/.aion"),
      "",
    ].join("\n"));
    return;
  }

  if (argv[0] === "setup") {
    const rl = createInterface();
    cfg = await runSetup(cfg, rl);
    rl.close();
    return;
  }

  if (argv[0] === "telegram") {
    const { runTelegramDaemon, runTelegramSetup, installAutostart, uninstallAutostart,
      startListenerBackground, stopListener, listenerPid } = await import("./telegram.mjs");
    const sub = argv[1];
    if (sub === "setup") {
      const rl = createInterface();
      await runTelegramSetup(cfg, rl);
      rl.close();
      return;
    }
    if (sub === "install") { await installAutostart(); return; }
    if (sub === "uninstall") { await uninstallAutostart(); return; }
    if (sub === "start") {
      if (!cfg.telegram?.token) { console.error("Not configured — run: aion telegram setup"); process.exit(1); }
      const r = startListenerBackground();
      console.log(`${r.already ? "already running" : "started in background"} (pid ${r.pid}) — log: ~/.aion/telegram.log`);
      return;
    }
    if (sub === "stop") {
      console.log(stopListener() ? "listener stopped" : "no listener running");
      return;
    }
    if (sub === "status") {
      const pid = listenerPid();
      console.log(pid ? `running (pid ${pid})` : "not running");
      return;
    }
    if (!cfg.telegram?.token) {
      // headless (autostart/service) must never hang in an interactive prompt
      if (!process.stdin.isTTY) {
        console.error("Telegram not configured — run: aion telegram setup");
        process.exit(1);
      }
      // first run: configure inline, then start listening
      const rl = createInterface();
      cfg = await runTelegramSetup(cfg, rl);
      rl.close();
      if (!cfg.telegram?.token) return;
    }
    await runTelegramDaemon(cfg);
    return;
  }

  // one-shot mode: aion -p "question"
  const pIdx = argv.indexOf("-p");
  if (pIdx !== -1 && argv[pIdx + 1]) {
    if (!cfg.setupComplete) {
      console.error("Run `aion` once to complete setup first.");
      process.exit(1);
    }
    const memory = new Memory();
    const prompt = argv.slice(pIdx + 1).join(" ");
    let out = "";
    const { content } = await runTurn(cfg, memory, [], prompt, (ev) => {
      if (ev.type === "token") { out += ev.token; process.stdout.write(ev.token); }
    });
    process.stdout.write("\n");
    memory.persist();
    // one-shot turns are resumable too: aion --continue picks them up
    const answer = content || out;
    if (answer?.trim()) {
      saveSession(newSessionId(), [
        { role: "user", content: prompt },
        { role: "assistant", content: answer },
      ], { model: cfg.model.id });
    }
    return;
  }

  // first run → setup wizard
  if (!cfg.setupComplete) {
    const rl = createInterface();
    cfg = await runSetup(cfg, rl);
    rl.close();
    if (!cfg.setupComplete) return;
    // fall through into the REPL with a fresh stdin
  }

  // keep the Telegram listener alive: if autostart is on and it died, revive it
  if (cfg.telegram?.autostart && cfg.telegram?.token) {
    try {
      const { listenerPid, startListenerBackground } = await import("./telegram.mjs");
      if (!listenerPid()) {
        const r = startListenerBackground();
        console.log(dim(`  📱 telegram listener started in background (pid ${r.pid})`));
      }
    } catch {}
  }

  // resume the previous conversation: aion --continue / -c
  let resume = null;
  if (argv.includes("--continue") || argv.includes("-c")) {
    resume = loadLatestSession();
    if (!resume) console.log(dim("  no previous session found — starting fresh"));
  }

  await runRepl(cfg, version, resume);
}
