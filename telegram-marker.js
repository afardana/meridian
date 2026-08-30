/**
 * Cross-process "last outbound Telegram message" marker.
 *
 * Lets the management cycle decide whether its rolling status bubble is still the
 * most recent message in the chat (→ edit it in place) or whether something else
 * was sent since (→ start a fresh bubble). Any process that sends a Telegram
 * message records the resulting message id (or a sentinel) here; the agent reads
 * it back. File-based so it works across the separate PM2 processes (agent,
 * db-backup cron, watchdog) on the same VM, regardless of persistence backend.
 *
 * Losing either file is harmless — the next cycle simply sends a fresh bubble.
 */
import fs from "fs";
import { repoPath } from "./repo-root.js";

const MARKER_PATH = repoPath(".telegram-marker.json");
const ROLLING_PATH = repoPath(".telegram-rolling.json");
const ROLLING_ROLES = new Set(["management", "screening"]);

function readJson(filePath) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function writeJson(filePath, value) {
  // A process-specific temporary path prevents the separate PM2 workers from
  // clobbering one another's temporary file while they record messages.
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, filePath);
}

/** Record the id of a newly-sent chat message (numeric id, or a string sentinel
 *  for senders that don't capture their id — anything that won't match a real
 *  message id is enough to invalidate the agent's reuse). */
export function recordOutboundMessage(id) {
  if (id == null) return;
  try {
    writeJson(MARKER_PATH, { id, ts: Date.now() });
  } catch {
    /* best-effort; a missing marker just forces a fresh bubble */
  }
}

/** The id of the most recent message sent to the chat by any process, or null. */
export function readLastOutboundId() {
  return readJson(MARKER_PATH).id ?? null;
}

/** Persist the current rolling bubble id so it survives a PM2 restart. */
export function recordRollingMessageId(role, id) {
  if (!ROLLING_ROLES.has(role) || id == null) return;
  try {
    const rolling = readJson(ROLLING_PATH);
    rolling[role] = id;
    rolling.ts = Date.now();
    writeJson(ROLLING_PATH, rolling);
  } catch {
    /* best-effort; a missing file only costs one fresh bubble */
  }
}

/** Read a persisted rolling bubble id, or null when none has been recorded. */
export function readRollingMessageId(role) {
  if (!ROLLING_ROLES.has(role)) return null;
  return readJson(ROLLING_PATH)[role] ?? null;
}

/** Clear a rolling id after Telegram confirms that its target no longer exists. */
export function clearRollingMessageId(role, expectedId = null) {
  if (!ROLLING_ROLES.has(role)) return;
  try {
    const rolling = readJson(ROLLING_PATH);
    if (expectedId != null && rolling[role] !== expectedId) return;
    delete rolling[role];
    rolling.ts = Date.now();
    writeJson(ROLLING_PATH, rolling);
  } catch {
    /* best-effort */
  }
}
