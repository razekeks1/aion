// AION ⇄ Telegram — talk to your agent from your phone.
// Zero deps: long-polling via fetch. Daemon: `aion telegram`.
// Autostart while the PC runs: `aion telegram install` (Windows Task Scheduler).
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AION_HOME, saveConfig } from "./config.mjs";
import { runTurn } from "./agent.mjs";
import { Memory } from "./memory.mjs";
import { violet, aqua, ok, warn, err, dim, bold, ask, askHidden, Spinner } from "./ui.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const memory = new Memory();
  const history = [];
  let offset = 0;
  console.log(`\n  ${violet("◆")} ${bold("AION Telegram listener")} ${dim("— bot @" + (t.botName || "?") + " · locked to user " + t.userId)}`);
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
const TASK_NAME = "AION Telegram Listener";

export async function installAutostart() {
  if (process.platform !== "win32") {
    console.log(`Create a user service, e.g. systemd:\n\n[Unit]\nDescription=AION Telegram\n[Service]\nExecStart=${process.execPath} ${path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "aion.mjs")} telegram\nRestart=always\n[Install]\nWantedBy=default.target\n`);
    return;
  }
  // hidden launcher (VBS) so no console window pops up at logon
  const binPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "aion.mjs");
  const logPath = path.join(AION_HOME, "telegram.log");
  const vbsPath = path.join(AION_HOME, "telegram-autostart.vbs");
  const cmd = `""${process.execPath}" "${binPath}" telegram >> "${logPath}" 2>&1"`;
  fs.writeFileSync(vbsPath, `CreateObject("Wscript.Shell").Run "cmd /c ${cmd.replace(/"/g, '""')}", 0, False\r\n`, "utf8");
  await new Promise((resolve, reject) => {
    execFile("schtasks.exe", ["/Create", "/F", "/TN", TASK_NAME, "/SC", "ONLOGON", "/TR", `wscript.exe "${vbsPath}"`],
      { windowsHide: true }, (e, so, se) => (e ? reject(new Error(se || e.message)) : resolve()));
  });
  console.log(`${ok("✔")} autostart installed — Telegram listener starts hidden at every logon`);
  console.log(dim(`  task: "${TASK_NAME}" · log: ${logPath} · start now: aion telegram · remove: aion telegram uninstall`));
}

export async function uninstallAutostart() {
  if (process.platform !== "win32") { console.log("Remove your systemd unit manually."); return; }
  await new Promise((resolve) => {
    execFile("schtasks.exe", ["/Delete", "/F", "/TN", TASK_NAME], { windowsHide: true }, () => resolve());
  });
  try { fs.unlinkSync(path.join(AION_HOME, "telegram-autostart.vbs")); } catch {}
  console.log(`${ok("✔")} autostart removed`);
}
