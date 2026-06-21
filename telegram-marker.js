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
 * Losing the file is harmless — the next cycle simply sends a fresh bubble.
 */
import fs from "fs";
import { repoPath } from "./repo-root.js";

const MARKER_PATH = repoPath(".telegram-marker.json");

/** Record the id of a newly-sent chat message (numeric id, or a string sentinel
 *  for senders that don't capture their id — anything that won't match a real
 *  message id is enough to invalidate the agent's reuse). */
export function recordOutboundMessage(id) {
  if (id == null) return;
  try {
    const tmp = `${MARKER_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ id, ts: Date.now() }));
    fs.renameSync(tmp, MARKER_PATH);
  } catch {
    /* best-effort; a missing marker just forces a fresh bubble */
  }
}

/** The id of the most recent message sent to the chat by any process, or null. */
export function readLastOutboundId() {
  try {
    return JSON.parse(fs.readFileSync(MARKER_PATH, "utf8")).id ?? null;
  } catch {
    return null;
  }
}
