#!/usr/bin/env node
// Meridian PM2 Heartbeat Watchdog
// Fully standalone — no imports from parent project. Node.js built-ins only.

import fs from 'fs';
import path from 'path';
import https from 'https';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Configuration (env vars with defaults) ---
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const HEARTBEAT_FILE = process.env.HEARTBEAT_FILE || path.resolve(__dirname, '../.heartbeat');
const STALE_THRESHOLD_MS = Number(process.env.STALE_THRESHOLD_MS) || 300_000;   // 5 min
const CHECK_INTERVAL_MS = Number(process.env.CHECK_INTERVAL_MS) || 60_000;      // 60s
const HEAP_WARN_MB = Number(process.env.HEAP_WARN_MB) || 400;
const LOOP_LAG_WARN_MS = Number(process.env.LOOP_LAG_WARN_MS) || 500;

// --- State ---
let consecutiveMissing = 0;
const restartTimestamps = [];          // tracks restart times for loop detection
let restartLoopLocked = false;         // true = stop auto-restarting
let lastHeapWarnAt = 0;
let lastLagWarnAt = 0;
const DEDUP_MS = 30 * 60_000;         // 30 min dedup window

// --- Telegram alert (HTTPS POST, fire-and-forget) ---
function sendTelegram(text) {
  if (!BOT_TOKEN || !CHAT_ID) return;
  const payload = JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML' });
  const req = https.request({
    hostname: 'api.telegram.org',
    path: `/bot${BOT_TOKEN}/sendMessage`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
  }, () => {});
  req.on('error', (e) => log(`Telegram send failed: ${e.message}`));
  req.end(payload);
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] [watchdog] ${msg}`);
}

// --- Main check loop ---
function check() {
  // 1. Read heartbeat file
  let raw;
  try {
    raw = fs.readFileSync(HEARTBEAT_FILE, 'utf8');
    consecutiveMissing = 0;
  } catch {
    consecutiveMissing++;
    log(`Heartbeat file missing (${consecutiveMissing} consecutive)`);
    if (consecutiveMissing > 10) {
      sendTelegram('⚠️ <b>Watchdog Warning</b>\nHeartbeat file missing for 10+ consecutive checks. Bot may not be writing heartbeats.');
      consecutiveMissing = 0; // reset so we don't spam
    }
    return;
  }

  // 2. Parse JSON
  let hb;
  try {
    hb = JSON.parse(raw);
  } catch {
    log('Heartbeat file parse error — treating as stale');
    handleStale(STALE_THRESHOLD_MS);
    return;
  }

  // 3. Check staleness
  const ageMs = Date.now() - hb.timestamp;
  if (ageMs > STALE_THRESHOLD_MS) {
    handleStale(ageMs);
    return;
  }

  // 4. Heap warning (deduped)
  if (hb.heap_mb > HEAP_WARN_MB && Date.now() - lastHeapWarnAt > DEDUP_MS) {
    lastHeapWarnAt = Date.now();
    const msg = `⚠️ <b>Watchdog Warning</b>\nMeridian heap usage: ${hb.heap_mb}MB (threshold: ${HEAP_WARN_MB}MB)`;
    log(msg.replace(/<[^>]+>/g, ''));
    sendTelegram(msg);
  }

  // 5. Event loop lag warning (deduped)
  if (hb.event_loop_lag_ms > LOOP_LAG_WARN_MS && Date.now() - lastLagWarnAt > DEDUP_MS) {
    lastLagWarnAt = Date.now();
    const msg = `⚠️ <b>Watchdog Warning</b>\nMeridian event loop lag: ${hb.event_loop_lag_ms}ms (threshold: ${LOOP_LAG_WARN_MS}ms)`;
    log(msg.replace(/<[^>]+>/g, ''));
    sendTelegram(msg);
  }
}

function handleStale(ageMs) {
  const ageSec = Math.round(ageMs / 1000);
  const now = Date.now();

  // Prune restart timestamps older than 30 min
  while (restartTimestamps.length && now - restartTimestamps[0] > DEDUP_MS) restartTimestamps.shift();

  // Restart-loop protection: 3+ restarts in 30 min → lock out
  if (restartTimestamps.length >= 3 || restartLoopLocked) {
    if (!restartLoopLocked) {
      restartLoopLocked = true;
      const msg = '🚨 <b>Watchdog CRITICAL</b>\nMeridian restarted 3+ times in 30 min. Stopping auto-restart. Manual intervention required.';
      log(msg.replace(/<[^>]+>/g, ''));
      sendTelegram(msg);
    }
    return;
  }

  // Restart PM2 process
  log(`Heartbeat stale (${ageSec}s). Restarting meridian...`);
  try {
    execSync('pm2 restart meridian', { timeout: 15_000, stdio: 'pipe' });
    restartTimestamps.push(now);
    sendTelegram(`🐕 <b>Watchdog Alert</b>\nMeridian heartbeat stale (${ageSec}s). Restarted PM2 process successfully.`);
  } catch (e) {
    const stderr = e.stderr ? e.stderr.toString().trim() : '';
    const errorDetail = stderr || e.message;
    log(`pm2 restart failed: ${errorDetail}`);
    sendTelegram(`❌ <b>Watchdog Error</b>\nFailed to restart Meridian:\n<code>${errorDetail}</code>`);
  }
}

// --- Startup ---
log(`Watchdog started | heartbeat=${HEARTBEAT_FILE} stale=${STALE_THRESHOLD_MS}ms interval=${CHECK_INTERVAL_MS}ms`);
setInterval(check, CHECK_INTERVAL_MS);
