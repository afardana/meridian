import fs from "fs";
import { repoPath } from "./repo-root.js";

const FILE_PATH = repoPath("logs/error-telemetry.json");
const MAX_EVENTS = 200;

let _errors = [];

function load() {
  try {
    if (fs.existsSync(FILE_PATH)) {
      _errors = JSON.parse(fs.readFileSync(FILE_PATH, "utf8"));
    }
  } catch {
    _errors = [];
  }
}

function save() {
  try {
    const dir = repoPath("logs");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(FILE_PATH, JSON.stringify(_errors, null, 2), "utf8");
  } catch {
    // ignore
  }
}

/**
 * Record an error event.
 * Categories: rpc_429, rpc_timeout, rpc_other, tx_failed, llm_error, state_corruption, memory_warning, generic
 */
export function recordError(category, message) {
  load();
  const event = {
    ts: new Date().toISOString(),
    category,
    message: String(message || "").trim().slice(0, 150),
  };
  _errors.unshift(event);
  _errors = _errors.slice(0, MAX_EVENTS);
  save();
}

export function getErrorStats() {
  load();
  const now = Date.now();
  const oneHour = 60 * 60 * 1000;
  const oneDay = 24 * 60 * 60 * 1000;

  const stats = {
    "1h": { total: 0 },
    "24h": { total: 0 },
  };

  for (const err of _errors) {
    const age = now - new Date(err.ts).getTime();
    if (age <= oneHour) {
      stats["1h"].total++;
      stats["1h"][err.category] = (stats["1h"][err.category] || 0) + 1;
    }
    if (age <= oneDay) {
      stats["24h"].total++;
      stats["24h"][err.category] = (stats["24h"][err.category] || 0) + 1;
    }
  }
  return stats;
}

export function getTelemetrySummary() {
  const stats = getErrorStats();
  const h1 = stats["1h"];
  const d24 = stats["24h"];

  const cats = ["rpc_429", "rpc_timeout", "tx_failed", "llm_error", "state_corruption", "memory_warning"];
  const h1Lines = cats.map(c => h1[c] ? `${c}: ${h1[c]}` : null).filter(Boolean);
  const d24Lines = cats.map(c => d24[c] ? `${c}: ${d24[c]}` : null).filter(Boolean);

  return [
    `Last 1h: ${h1.total} total${h1Lines.length > 0 ? ` (${h1Lines.join(", ")})` : ""}`,
    `Last 24h: ${d24.total} total${d24Lines.length > 0 ? ` (${d24Lines.join(", ")})` : ""}`,
  ].join("\n");
}
