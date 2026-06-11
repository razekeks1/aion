// AION ⇄ Telegram — talk to your agent from your phone.
// Zero deps: long-polling via fetch. Daemon: `aion telegram`.
// Autostart while the PC runs: `aion telegram install` (Windows Task Scheduler).
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AION_HOME, saveConfig } from "./config.mjs";
import { runTurn } from "./agent.mjs";
import { Memory } from "./memory.mjs";
import { violet, aqua, ok, warn, err, dim, bold, ask, askHidden, Spinner } from "./ui.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PID_FILE = path.join(AION_HOME, "telegram.pid");
const LOG_FILE = path.join(AION_HOME, "telegram.log");
const BIN_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "aion.mjs");

// ── background lifecycle ─────────────────────────────────
// PID of a live listener, or null. Never matches the calling process.
export function listenerPid() {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, "utf8"), 10);
    if (pid && pid !== process.pid) {
      process.kill(pid, 0); // throws if the process is gone
      return pid;
    }
  } catch {}
  return null;
}

// Detached, hidden, logs to ~/.aion/telegram.log. Returns the pid (or the
// already-running one). Survives the parent exiting.
export function startListenerBackground() {
  const running = listenerPid();
  if (running) return { pid: running, already: true };
  fs.mkdirSync(AION_HOME, { recursive: true });
  const out = fs.openSync(LOG_FILE, "a");
  const child = spawn(process.execPath, [BIN_PATH, "telegram"], {
    detached: true,
    stdio: ["ignore", out, out],
    windowsHide: true,
  });
  child.unref();
  fs.closeSync(out);
  return { pid: child.pid, already: false };
}

export function stopListener() {
  const pid = listenerPid();
  if (!pid) return false;
  try { process.kill(pid); } catch { return false; }
  try { fs.unlinkSync(PID_FILE); } catch {}
  return true;
}

export async function tgApi(token, method, params = {}, timeoutMs = 30000) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const d = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
  if (!d.ok) throw new Error(`telegram ${method}: ${d.description || res.status}`);
  return d.result;
}

// Telegram caps messages at 4096 chars — split on paragraph/line boundaries.
export function splitChunks(text, max = 4000) {
  const chunks = [];
  let rest = String(text);
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(" ", max);
    if (cut < max * 0.5) cut = max;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\s+/, "");
  }
  if (rest) chunks.push(rest);
  return chunks;
}

async function sendChunked(token, chatId, text) {
  for (const chunk of splitChunks(text)) {
    await tgApi(token, "sendMessage", { chat_id: chatId, text: chunk });
  }
}

// ── setup: token + identity verification (Hermes-style) ──
export async function runTelegramSetup(cfg, rl) {
  console.log(`\n  ${bold("Telegram")} ${dim("— talk to Aion from your phone")}`);
  console.log(dim("  1. Open @BotFather in Telegram → /newbot → copy the token"));
  const cur = cfg.telegram?.token ? dim(` (Enter = keep current ${cfg.telegram.token.slice(0, 10)}…)`) : "";
  const token = (await askHidden(rl, `  Bot token${cur}: `)) || cfg.telegram?.token;
  if (!token) { console.log(dim("  skipped")); return cfg; }

  const sp = new Spinner("checking bot…").start();
  let me;
  try { me = await tgApi(token, "getMe", {}, 10000); } catch (e) {
    sp.stop(`  ${err("✖")} invalid token: ${e.message}`);
    return cfg;
  }
  sp.stop(`  ${ok("✔")} bot ${aqua("@" + me.username)} connected`);

  // identity check: the user proves who they are by messaging the bot
  console.log(`  ${violet("◆")} Now send ${bold("any message")} to ${aqua("@" + me.username)} from YOUR Telegram account.`);
  const sp2 = new Spinner("waiting for your message (60s)…").start();
  let sender = null;
  try {
    // drain old updates first so a stranger's old message can't be picked up
    const stale = await tgApi(token, "getUpdates", { timeout: 0 }, 10000);
    let offset = stale.length ? stale[stale.length - 1].update_id + 1 : 0;
    const t0 = Date.now();
    while (Date.now() - t0 < 60000 && !sender) {
      const updates = await tgApi(token, "getUpdates", { offset, timeout: 25 }, 35000);
      for (const u of updates) {
        offset = u.update_id + 1;
        if (u.message?.from && u.message.chat?.type === "private") {
          sender = { id: u.message.from.id, chatId: u.message.chat.id, name: [u.message.from.first_name, u.message.from.last_name].filter(Boolean).join(" "), username: u.message.from.username };
          break;
        }
      }
    }
  } catch {}
  sp2.stop();
  if (!sender) {
    console.log(`  ${err("✖")} no message received — run ${aqua("aion telegram setup")} to retry`);
    return cfg;
  }
  const who = `${sender.name}${sender.username ? " (@" + sender.username + ")" : ""} · id ${sender.id}`;
  const yes = await ask(rl, `  Lock the bot to ${bold(who)}? ${dim("(Y/n)")} `);
  if (yes && !/^y/i.test(yes)) { console.log(dim("  cancelled")); return cfg; }

  cfg.telegram = { token, userId: sender.id, chatId: sender.chatId, username: sender.username || "", botName: me.username };
  saveConfig(cfg);
  await tgApi(token, "sendMessage", { chat_id: sender.chatId, text: "✔ AION linked. Only this account can talk to me.\nStart the listener on your PC with:  aion telegram" });
  console.log(`  ${ok("✔")} Telegram linked to ${who}`);
  console.log(`  ${violet("◆")} start listening:  ${aqua("aion telegram")}   ${dim("· autostart at logon:")} ${aqua("aion telegram install")}`);
  return cfg;
}

// ── daemon: long-poll loop, full agent per message ───────
export async function runTelegramDaemon(cfg) {
  const t = cfg.telegram;
  if (!t?.token || !t?.userId) {
    console.error(`Telegram is not configured. Run: ${aqua("aion telegram setup")}`);
    process.exit(1);
  }
  const other = listenerPid();
  if (other) {
    console.error(`Listener already running (pid ${other}). Stop it with: aion telegram stop`);
    process.exit(1);
  }
  fs.mkdirSync(AION_HOME, { recursive: true });
  fs.writeFileSync(PID_FILE, String(process.pid), "utf8");
  const cleanup = () => { try { if (parseInt(fs.readFileSync(PID_FILE, "utf8"), 10) === process.pid) fs.unlinkSync(PID_FILE); } catch {} };
  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(0); });
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });

  const memory = new Memory();
  const history = [];
  let offset = 0;
  console.log(`\n  ${violet("◆")} ${bold("AION Telegram listener")} ${dim("— bot @" + (t.botName || "?") + " · locked to user " + t.userId + " · pid " + process.pid)}`);
  console.log(dim("  long-polling · Ctrl+C to stop\n"));

  let failures = 0;
  for (;;) {
    try {
      const updates = await tgApi(t.token, "getUpdates", { offset, timeout: 50 }, 60000);
      failures = 0;
      for (const u of updates) {
        offset = u.update_id + 1;
        const msg = u.message;
        if (!msg?.text) continue;
        if (msg.from?.id !== t.userId) {
          await tgApi(t.token, "sendMessage", { chat_id: msg.chat.id, text: "⛔ This AION instance is private." }).catch(() => {});
          console.log(warn(`  ⛔ rejected message from ${msg.from?.id}`));
          continue;
        }
        const text = msg.text.trim();
        console.log(`  ${aqua("❯")} ${text.slice(0, 80)}`);
        if (text === "/start" || text === "/help") {
          await sendChunked(t.token, msg.chat.id, "AION here. Just talk — I have my full memory, tools and your machine at hand.\n/status — listener status");
          continue;
        }
        if (text === "/status") {
          await sendChunked(t.token, msg.chat.id, `✔ online on ${os.hostname()} · model ${cfg.model.id} · ${memory.stats()}`);
          continue;
        }
        await tgApi(t.token, "sendChatAction", { chat_id: msg.chat.id, action: "typing" }).catch(() => {});
        const keepTyping = setInterval(() => {
          tgApi(t.token, "sendChatAction", { chat_id: msg.chat.id, action: "typing" }).catch(() => {});
        }, 5000);
        try {
          const { content } = await runTurn(cfg, memory, history, text, () => {});
          clearInterval(keepTyping);
          const answer = content?.trim() || "(no response — try again)";
          history.push({ role: "user", content: text }, { role: "assistant", content: answer });
          if (history.length > 30) history.splice(0, history.length - 20);
          memory.addEpisode(`[telegram] User: ${text.slice(0, 150)} → Aion: ${answer.slice(0, 180)}`);
          memory.persist();
          await sendChunked(t.token, msg.chat.id, answer);
          console.log(`  ${ok("✔")} replied (${answer.length} chars)`);
        } catch (e) {
          clearInterval(keepTyping);
          await sendChunked(t.token, msg.chat.id, `✖ ${e.message}`).catch(() => {});
          console.log(err(`  ✖ turn failed: ${e.message}`));
        }
      }
    } catch (e) {
      failures++;
      console.log(dim(`  … network hiccup (${e.message?.slice(0, 60)}), retrying`));
      await sleep(Math.min(30000, 1500 * failures));
    }
  }
}

// ── autostart while the PC runs ──────────────────────────
// Windows: Task Scheduler (hidden via VBS) · macOS: launchd LaunchAgent ·
// Linux: systemd user unit. All per-user, no admin/root needed.
const TASK_NAME = "AION Telegram Listener";
const PLIST_PATH = path.join(os.homedir(), "Library", "LaunchAgents", "com.aion.telegram.plist");
const UNIT_DIR = path.join(os.homedir(), ".config", "systemd", "user");
const UNIT_PATH = path.join(UNIT_DIR, "aion-telegram.service");

const run = (cmd, args) => new Promise((resolve, reject) => {
  execFile(cmd, args, { windowsHide: true }, (e, so, se) => (e ? reject(new Error((se || e.message).trim())) : resolve(so)));
});

export async function installAutostart() {
  if (process.platform === "darwin") {
    fs.mkdirSync(path.dirname(PLIST_PATH), { recursive: true });
    fs.writeFileSync(PLIST_PATH, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.aion.telegram</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${BIN_PATH}</string>
    <string>telegram</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${LOG_FILE}</string>
  <key>StandardErrorPath</key><string>${LOG_FILE}</string>
</dict>
</plist>
`, "utf8");
    await run("launchctl", ["unload", PLIST_PATH]).catch(() => {});
    await run("launchctl", ["load", "-w", PLIST_PATH]);
    console.log(`${ok("✔")} autostart installed — LaunchAgent com.aion.telegram starts at every login`);
    console.log(dim(`  log: ${LOG_FILE} · remove: aion telegram uninstall`));
    return;
  }
  if (process.platform === "linux") {
    fs.mkdirSync(UNIT_DIR, { recursive: true });
    fs.writeFileSync(UNIT_PATH, `[Unit]
Description=AION Telegram listener

[Service]
ExecStart=${process.execPath} ${BIN_PATH} telegram
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`, "utf8");
    try {
      await run("systemctl", ["--user", "daemon-reload"]);
      await run("systemctl", ["--user", "enable", "--now", "aion-telegram.service"]);
      console.log(`${ok("✔")} autostart installed — systemd user service aion-telegram is enabled and running`);
    } catch (e) {
      console.log(`${warn("⚠")} unit written to ${UNIT_PATH}, but systemctl failed (${e.message.slice(0, 80)})`);
      console.log(dim("  enable manually: systemctl --user enable --now aion-telegram.service"));
    }
    return;
  }
  // Windows: HKCU Run key + hidden VBS launcher — works for every user,
  // no admin rights needed (schtasks ONLOGON would require elevation)
  const vbsPath = path.join(AION_HOME, "telegram-autostart.vbs");
  const cmd = `""${process.execPath}" "${BIN_PATH}" telegram >> "${LOG_FILE}" 2>&1"`;
  fs.writeFileSync(vbsPath, `CreateObject("Wscript.Shell").Run "cmd /c ${cmd.replace(/"/g, '""')}", 0, False\r\n`, "utf8");
  await run("reg.exe", ["add", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
    "/v", "AION-Telegram", "/t", "REG_SZ", "/d", `wscript.exe "${vbsPath}"`, "/f"]);
  console.log(`${ok("✔")} autostart installed — Telegram listener starts hidden at every logon`);
  console.log(dim(`  log: ${LOG_FILE} · start now: aion telegram · remove: aion telegram uninstall`));
}

export async function uninstallAutostart() {
  if (process.platform === "darwin") {
    await run("launchctl", ["unload", PLIST_PATH]).catch(() => {});
    try { fs.unlinkSync(PLIST_PATH); } catch {}
    console.log(`${ok("✔")} autostart removed`);
    return;
  }
  if (process.platform === "linux") {
    await run("systemctl", ["--user", "disable", "--now", "aion-telegram.service"]).catch(() => {});
    try { fs.unlinkSync(UNIT_PATH); } catch {}
    console.log(`${ok("✔")} autostart removed`);
    return;
  }
  await run("reg.exe", ["delete", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "/v", "AION-Telegram", "/f"]).catch(() => {});
  await run("schtasks.exe", ["/Delete", "/F", "/TN", TASK_NAME]).catch(() => {}); // legacy cleanup
  try { fs.unlinkSync(path.join(AION_HOME, "telegram-autostart.vbs")); } catch {}
  console.log(`${ok("✔")} autostart removed`);
}
