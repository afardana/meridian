import fs from "fs";
import path from "path";
import { repoPath } from "./repo-root.js";

const LOG_DIR = repoPath("logs");
const LOG_LEVEL = process.env.LOG_LEVEL || "info";

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = LEVELS[LOG_LEVEL] || 1;

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

/**
 * Format timestamp in local VM timezone with offset (e.g., YYYY-MM-DDTHH:mm:ss.sss+07:00)
 */
export function getLocalTimestamp() {
  const d = new Date();
  const tzOffset = -d.getTimezoneOffset();
  const diff = tzOffset >= 0 ? "+" : "-";
  const pad = (num) => String(num).padStart(2, "0");
  const pad3 = (num) => String(num).padStart(3, "0");
  const localTime = new Date(d.getTime() + tzOffset * 60 * 1000);
  return `${localTime.getUTCFullYear()}-${pad(localTime.getUTCMonth() + 1)}-${pad(localTime.getUTCDate())}T${pad(localTime.getUTCHours())}:${pad(localTime.getUTCMinutes())}:${pad(localTime.getUTCSeconds())}.${pad3(localTime.getUTCMilliseconds())}${diff}${pad(Math.floor(Math.abs(tzOffset) / 60))}:${pad(Math.abs(tzOffset) % 60)}`;
}

// Secret query params that must never reach log files (e.g. Helius api-key,
// backrun rebate-address). Sink-level scrub: catches URLs embedded in error
// messages too, which per-call-site maskUrl() can't.
const SECRET_PARAM_RE = /([?&](?:api-key|api_key|apikey|rebate-address)=)[^&\s"'`)\]]+/gi;

export function redactSecrets(text) {
  return typeof text === "string" ? text.replace(SECRET_PARAM_RE, "$1***") : text;
}

/**
 * General log function.
 */
export function log(category, message) {
  const level = category.includes("error") ? "error"
    : category.includes("warn") ? "warn"
    : "info";

  if (LEVELS[level] < currentLevel) return;

  const timestamp = getLocalTimestamp();
  const line = redactSecrets(`[${timestamp}] [${category.toUpperCase()}] ${message}`);

  // Console output (stderr to keep stdout clean for JSON parsing)
  console.error(line);

  // File output (daily rotation)
  const dateStr = timestamp.split("T")[0];
  const logFile = path.join(LOG_DIR, `agent-${dateStr}.log`);
  fs.appendFileSync(logFile, line + "\n");
}

/**
 * Log a tool action with full details (for audit trail).
 */
function actionHint(action) {
  const a = action.args || {};
  const r = action.result || {};
  switch (action.tool) {
    case "deploy_position":   return ` ${a.pool_name || a.pool_address?.slice(0,8)} ${a.amount_sol} SOL`;
    case "close_position":    return ` ${a.position_address?.slice(0,8)}${r.pnl_usd != null ? ` | PnL $${r.pnl_usd >= 0 ? "+" : ""}${r.pnl_usd} (${r.pnl_pct}%)` : ""}`;
    case "claim_fees":        return ` ${a.position_address?.slice(0,8)}`;
    case "get_active_bin":    return ` bin ${r.binId ?? ""}`;
    case "get_pool_detail":   return ` ${r.name || a.pool_address?.slice(0,8) || ""}`;
    case "get_my_positions":  return ` ${r.total_positions ?? ""} positions`;
    case "get_wallet_balance":return ` ${r.sol ?? ""} SOL`;
    case "get_top_candidates":return ` ${r?.candidates?.length ?? ""} pools`;
    case "swap_token":        return ` ${a.amount} ${a.input_mint?.slice(0,6)}→SOL`;
    case "update_config":     return ` ${Object.keys(r.applied || {}).join(", ")}`;
    case "add_lesson":        return ` saved`;
    case "clear_lessons":     return ` cleared ${r.cleared ?? ""}`;
    default:                  return "";
  }
}

export function logAction(action) {
  const timestamp = getLocalTimestamp();

  const entry = { timestamp, ...action };

  // Console: single clean line, no raw JSON
  const status = action.success ? "✓" : "✗";
  const dur = action.duration_ms != null ? ` (${action.duration_ms}ms)` : "";
  const hint = actionHint(action);
  // Console output (stderr to keep stdout clean for JSON parsing)
  console.error(`[${action.tool}] ${status}${hint}${dur}`);

  // File: full JSON for audit trail
  const dateStr = timestamp.split("T")[0];
  const actionsFile = path.join(LOG_DIR, `actions-${dateStr}.jsonl`);
  fs.appendFileSync(actionsFile, redactSecrets(JSON.stringify(entry)) + "\n");
}

/**
 * Log a portfolio snapshot (for tracking performance over time).
 */
export function logSnapshot(snapshot) {
  const timestamp = getLocalTimestamp();

  const entry = {
    timestamp,
    ...snapshot,
  };

  const dateStr = timestamp.split("T")[0];
  const snapshotFile = path.join(LOG_DIR, `snapshots-${dateStr}.jsonl`);
  fs.appendFileSync(snapshotFile, JSON.stringify(entry) + "\n");
}
