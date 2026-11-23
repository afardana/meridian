#!/usr/bin/env node
/**
 * Send ONE plain-text Telegram message from the experiment loop (promotion, revert, escalation,
 * daily verdict summary). Text comes from stdin; the bot token and chat id are read from .env here
 * and never printed. Run on the VM as angga:
 *
 *   echo "text" | node scripts/experiments/notify.js
 *
 * Same pattern as scripts/db_backup.js: a standalone ping that records the message id so the
 * agent's rolling status bubble knows a message was interleaved. Exit 0 sent, 1 not sent.
 */
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { recordOutboundMessage } from "../../telegram-marker.js";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
dotenv.config({ path: path.join(repoRoot, ".env") });

let text = "";
for await (const chunk of process.stdin) text += chunk;
text = text.trim();
if (!text) {
  console.error("notify.js: empty message");
  process.exit(1);
}
const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
if (!token || !chatId) {
  console.error("notify.js: Telegram is not configured");
  process.exit(1);
}
try {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: `🧪 Experiments\n${text}`.slice(0, 4000) }),
  });
  const json = await res.json().catch(() => null);
  if (!json?.ok) {
    console.error(`notify.js: Telegram refused the message (${res.status})`);
    process.exit(1);
  }
  recordOutboundMessage(json.result?.message_id ?? `experiments-${Date.now()}`);
  console.log("sent");
} catch (e) {
  console.error(`notify.js: ${e.message}`);
  process.exit(1);
}
