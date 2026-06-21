/**
 * Phase 6 — PostgreSQL backup for the `meridian` database.
 *
 * Runs as a PM2 cron app (`meridian-db-backup`, daily). Takes a compressed
 * custom-format pg_dump, keeps the most recent N, and pings Telegram.
 *
 * Backups live OUTSIDE the repo (default /opt/meridian-backups) so the hourly
 * git syncer's `reset --hard` can never touch them.
 *
 * Restore (custom format):
 *   pg_restore -h 127.0.0.1 -U meridian -d meridian --clean --if-exists <file.dump>
 *
 * Manual run: `node scripts/db_backup.js`
 */

import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { recordOutboundMessage } from "../telegram-marker.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.join(__dirname, "..");
dotenv.config({ path: path.join(repoRoot, ".env") });

const BACKUP_DIR = process.env.PG_BACKUP_DIR || "/opt/meridian-backups";
const KEEP = Number(process.env.PG_BACKUP_KEEP || 14);
const DB = process.env.PGDATABASE || "meridian";
const HOST = process.env.PGHOST || "127.0.0.1";
const PORT = process.env.PGPORT || "5432";
const USER = process.env.PGUSER || "meridian";

function stamp() {
  // YYYYMMDD-HHMMSS in UTC, no separators that break filenames
  const d = new Date().toISOString().replace(/[-:T]/g, ""); // 20260618164401.123Z
  return `${d.slice(0, 8)}-${d.slice(8, 14)}`;               // 20260618-164401
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000), parse_mode: "Markdown" }),
    });
    // Record so the agent's rolling status bubble knows a message was interleaved.
    const json = await res.json().catch(() => null);
    recordOutboundMessage(json?.result?.message_id ?? `db-backup-${Date.now()}`);
  } catch (e) {
    console.error("Telegram notify failed:", e.message);
  }
}

function prune() {
  const files = fs.readdirSync(BACKUP_DIR)
    .filter((f) => f.startsWith(`${DB}-`) && f.endsWith(".dump"))
    .sort(); // lexical sort == chronological for our stamp format
  const excess = files.slice(0, Math.max(0, files.length - KEEP));
  for (const f of excess) {
    try { fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch { /* ignore */ }
  }
  return { kept: Math.min(files.length, KEEP), pruned: excess.length };
}

async function main() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const outFile = path.join(BACKUP_DIR, `${DB}-${stamp()}.dump`);

  try {
    // -Fc = custom (compressed) format; suitable for pg_restore.
    execFileSync(
      "pg_dump",
      ["-Fc", "-h", HOST, "-p", String(PORT), "-U", USER, "-d", DB, "-f", outFile],
      { env: { ...process.env }, stdio: "pipe" }
    );
    const sizeMb = (fs.statSync(outFile).size / 1e6).toFixed(2);
    const { kept, pruned } = prune();
    console.log(`Backup OK: ${outFile} (${sizeMb} MB). Kept ${kept}, pruned ${pruned}.`);
    await sendTelegram(`💾 *Meridian DB backup OK*\n\`${path.basename(outFile)}\` (${sizeMb} MB)\nRetention: ${kept} kept, ${pruned} pruned.`);
  } catch (err) {
    const msg = (err.stderr?.toString() || err.message || "unknown").slice(0, 500);
    console.error("Backup FAILED:", msg);
    try { if (fs.existsSync(outFile)) fs.unlinkSync(outFile); } catch { /* ignore partial */ }
    await sendTelegram(`❌ *Meridian DB backup FAILED*\n\`${msg}\``);
    process.exitCode = 1;
  }
}

main();
