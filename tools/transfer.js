/**
 * Profit skimmer — chain I/O (2026-11-25 rewrite). The decision is in ../skim-policy.js.
 *
 * - The destination (2026-11-27): the skim journal's newest destination_change line is the
 *   truth (`to`, or null = .env PIONEX_DEPOSIT_ADDRESS, read once); skim-destination.json
 *   (data dir) must match it exactly or everything is refused — see ../skim-destination.js.
 *   Changes are journalled FIRST, then the file is written from the journal
 *   (applySkimDestinationChange / applySkimDestinationVerified, after the two-step
 *   /skim address flow). user-config.json, update_config and the LLM cannot reach it.
 *   Every resolve is format-checked; verifySkimDestinationOnChain() adds the on-chain
 *   check (plain system wallet), and sendSkim re-resolves it fresh before and inside its
 *   claim window. Every log line and error text here passes through maskAddressesIn().
 * - The skim journal (skim-journal.jsonl, append-only, fsync'd, directory fsync'd on
 *   creation, torn last line repaired with a newline before the next append) is the
 *   write-ahead record of every skim. Each event is mirrored into the kv_store document
 *   "skim-ledger" so the daily pg_dump covers it. skimIntegrity() refuses every skim when
 *   the journal has an unreadable line, is missing while the mirror has entries, misses a
 *   mirrored signature, or misses a skim the baseline has booked.
 * - sendSkim() is the only function that signs a transfer. Its pre-broadcast section runs
 *   under a hard deadline (30 s): claim the close slot + pause new poller ticks (sync),
 *   wait for a running tick, re-check in-flight work, re-read the balance (must match the
 *   decision's), build ComputeBudget price + limit + ONE SystemProgram.transfer, simulate
 *   (fail closed), journal "pending" + flush state, broadcast — and the claim is released
 *   at the broadcast (or on any exit). The outcome is then polled; an unknown outcome stays
 *   pending and blocks every later skim until resolvePendingSkims() settles it.
 * - DRY_RUN=true stops after the simulation.
 */
import fs from "node:fs";
import path from "node:path";
import bs58 from "bs58";
import {
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { log as rawLog } from "../logger.js";
import { dataPath } from "../repo-root.js";
import { config, setSkimOffLatch } from "../config.js";
import { getSolPriceUsd } from "../sol-price.js";
import { makeDocStore } from "../db/doc-store.js";
import { getBaselineState, saveBaselineState, getTrackedPosition, getTrackedPositions, flushState } from "../state.js";
import { getWallet, getWalletAddress, getConnection } from "./wallet.js";
import {
  parseSkimAddressInput,
  parseSkimDestinationOverride,
  resolveSkimDestination,
  buildDestinationChangeLine,
  destinationChangeRefusal,
  verifyRefusal,
  journalDestinationChanges,
  journalDestinationState,
  skimEntryDestinations,
  skimAddressHoldHours,
} from "../skim-destination.js";
import { fmtWib } from "../wib-time.js";
import {
  checkSkimDestination,
  checkSkimDestinationAccount,
  reduceSkimJournal,
  resolveSkimStatus,
  needsTxLookup,
  operatorResolveRefusal,
  bookSkimWithdrawal,
  maskAddress,
  skimConfig,
  skimIntegrity,
  untrackedSwapSol,
  computeSkimDecision,
  withDeadline,
  adoptRefusal,
  maskAddressesIn,
  testTransferSolFromEnv,
  testTransfersSince,
  LEGACY_SKIM_REASONS,
} from "../skim-policy.js";

const PRIORITY_FEE_MICRO_LAMPORTS = 50_000;
const COMPUTE_UNIT_LIMIT = 2_000;
const BASE_FEE_LAMPORTS = 5_000;
const CONFIRM_POLL_MS = 1_500;
const CONFIRM_MAX_MS = 120_000;
export const SKIM_PRE_BROADCAST_DEADLINE_MS = 30_000;

/** Every skim log line goes through the sanitiser: no address-length base58 run reaches a log. */
const log = (category, message) => rawLog(category, maskAddressesIn(String(message)));

// ─── destination (journal = truth; the file must match it; else .env) ───────────
let _envDestination = null;   // the .env value, format-checked once for process.env
let _onChainCache = null;     // { address } — the last successful on-chain check (not used by sendSkim)

export function skimDestinationFile() { return dataPath("skim-destination.json"); }

/**
 * The destination file and the journal live in the same data dir: when only one of them is
 * given (tests, tools), the other is taken from its directory — never a file in one dir checked
 * against the journal of another.
 */
function destinationPaths({ file, journalFile } = {}) {
  return {
    file: file ?? (journalFile ? path.join(path.dirname(journalFile), "skim-destination.json") : skimDestinationFile()),
    journalFile: journalFile ?? (file ? path.join(path.dirname(file), "skim-journal.jsonl") : undefined),
  };
}

/** The .env destination, format-checked (cached once for process.env). */
export function getEnvSkimDestination({ env = process.env, walletAddress } = {}) {
  if (env === process.env) {
    if (!_envDestination) _envDestination = Object.freeze(checkSkimDestination(env.PIONEX_DEPOSIT_ADDRESS, { walletAddress: walletAddress ?? getWalletAddress() }));
    return _envDestination;
  }
  return checkSkimDestination(env?.PIONEX_DEPOSIT_ADDRESS, { walletAddress: walletAddress ?? getWalletAddress() });
}

/** skim-destination.json, shape-checked. Re-read on every call; an unreadable file is `{ exists:true, ok:false }`. */
export function readSkimDestinationOverride({ file = skimDestinationFile(), walletAddress } = {}) {
  let text = null;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) {
    if (e.code !== "ENOENT") return { exists: true, ok: false, address: null, error: `cannot be read (${e.code || "error"})` };
  }
  return parseSkimDestinationOverride(text, { walletAddress: walletAddress ?? getWalletAddress() });
}

/** The journal as the destination resolver needs it: { events, corrupt, error }. */
function loadJournalForDestination(journalFile) {
  try { const l = loadSkimJournal(journalFile); return { events: l.events, corrupt: l.corrupt, error: null }; }
  catch (e) { return { events: [], corrupt: 0, error: maskAddressesIn(e.message) }; }
}

/**
 * The effective destination, format-checked (no RPC):
 * { ok, address, masked, source, error, hold_until, holdActive, verified, changed_at, corrupt, mismatch }.
 * The journal's newest destination_change line is the truth; the file must match it. During
 * the hold, and on any mismatch, ok is false.
 */
let _lastCorruptLogged = null;
export function getSkimDestination({ env = process.env, walletAddress, file: fileIn, journalFile: journalIn, now = Date.now() } = {}) {
  const wa = walletAddress ?? getWalletAddress();
  const { file, journalFile } = destinationPaths({ file: fileIn, journalFile: journalIn });
  const d = Object.freeze(resolveSkimDestination({
    envDestination: getEnvSkimDestination({ env, walletAddress: wa }),
    override: readSkimDestinationOverride({ file, walletAddress: wa }),
    journal: loadJournalForDestination(journalFile),
    now,
  }));
  if (d.corrupt && d.error !== _lastCorruptLogged) { _lastCorruptLogged = d.error; log("skim_error", `[SKIM] ${d.error}`); }
  else if (!d.corrupt) _lastCorruptLogged = null;
  return d;
}

/** The account as the chain shows it; an RPC failure refuses (its text sanitised). → { ok, error, exists } */
async function checkAccountOnChain(conn, address) {
  try {
    const info = await conn.getAccountInfo(new PublicKey(address), "confirmed");
    const r = checkSkimDestinationAccount(info);
    return { ...r, error: maskAddressesIn(r.error), exists: info != null };
  } catch (e) {
    return { ok: false, error: `destination account could not be read: ${maskAddressesIn(e?.message || String(e))}` };
  }
}

/**
 * The effective destination + the on-chain account check. `fresh` skips the per-address
 * cache (sendSkim, address changes).
 */
export async function verifySkimDestinationOnChain({ conn = null, fresh = false, env, file, journalFile, walletAddress, now } = {}) {
  const dest = getSkimDestination({ env, file, journalFile, walletAddress, now });
  if (!dest.ok) return dest;
  if (!fresh && _onChainCache?.address === dest.address) return Object.freeze({ ...dest, onChainChecked: true });
  const acct = await checkAccountOnChain(conn || getConnection(), dest.address);
  if (!acct.ok) return Object.freeze({ ...dest, ok: false, error: acct.error });
  _onChainCache = { address: dest.address };
  return Object.freeze({ ...dest, onChainChecked: true });
}

/** /skim address <base58>: format + on-chain checks of a new destination (RPC failure refuses). → { ok, address, masked, onChain:{exists}, error } */
export async function checkSkimAddressCandidate(raw, { conn = null, walletAddress } = {}) {
  const parsed = parseSkimAddressInput(raw, { walletAddress: walletAddress ?? getWalletAddress() });
  if (!parsed.ok) return parsed;
  let c;
  try { c = conn || getConnection(); } catch (e) { return { ...parsed, ok: false, error: `destination account could not be read: ${maskAddressesIn(e.message)}` }; }
  const acct = await checkAccountOnChain(c, parsed.address);
  if (!acct.ok) return { ...parsed, ok: false, error: acct.error };
  return { ...parsed, onChain: { exists: acct.exists === true } };
}

/** For tests only. */
export function _resetSkimDestinationCache() { _envDestination = null; _onChainCache = null; _lastCorruptLogged = null; }

/**
 * Replace a whole file durably: a stale temp file is unlinked, the temp file is created
 * exclusively ("wx", never following a pre-placed symlink), fsync'd, renamed, then the
 * directory is fsync'd. The temp file is removed on any failure before the rename.
 * → { renamed: true, dirSyncError: Error|null } ; throws when nothing was renamed.
 */
function writeFileDurable(file, text) {
  const dir = path.dirname(file);
  const tmp = `${file}.${process.pid}.tmp`;
  try { fs.unlinkSync(tmp); } catch (e) { if (e.code !== "ENOENT") throw e; }
  let fd;
  try {
    fd = fs.openSync(tmp, "wx", 0o600);
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = null;
    fs.renameSync(tmp, file);
  } catch (e) {
    if (fd != null) try { fs.closeSync(fd); } catch { /* */ }
    try { fs.unlinkSync(tmp); } catch { /* */ }
    throw e;
  }
  let dirSyncError = null;
  try { fsyncDir(dir); } catch (e) { dirSyncError = e; }
  return { renamed: true, dirSyncError };
}

/** Write skim-destination.json as the journal's newest destination state says. → { written, warning, error } */
function writeDestinationFileFromJournal(file, journalFile) {
  const js = journalDestinationState(loadSkimJournal(journalFile).events);
  if (!js.fileRecord) return { written: false, error: "the journal has no destination change" };
  try {
    const w = writeFileDurable(file, `${JSON.stringify(js.fileRecord, null, 2)}\n`);
    return { written: true, warning: w.dirSyncError ? `the directory could not be synced (${maskAddressesIn(w.dirSyncError.message)}) — the file is in place but may not survive a power loss` : null };
  } catch (e) {
    return { written: false, error: maskAddressesIn(e.message) };
  }
}

/**
 * Apply a confirmed /skim address change (kind "set": to = the new address; "reset": back
 * to .env). Synchronous from the first check to the last write, so no skim can start in
 * between. Order: refusals → the journal line, durably (the truth) → the file, from the
 * journal → cancel the open proposal → re-read and report what is in effect. A journal line
 * is never rolled back; a failed file write leaves the state "mismatch → refuse" and says so.
 * Also the repair path: a mismatched / missing / unreadable file is not a refusal.
 *   busy = { sendInFlight, confirmInFlight, proposeInFlight }
 * → { ok, journalled, kind, fromMasked, toMasked, holdUntil, holdUntilMs, source, warning?, error? }
 */
export function applySkimDestinationChange(change, {
  file: fileIn, journalFile: journalIn, mirror = defaultSkimMirror, env = process.env, walletAddress,
  now = Date.now(), busy = {}, cancelProposal = () => {}, holdHours = skimAddressHoldHours(env), getBaseline = getBaselineState,
} = {}) {
  const wa = walletAddress ?? getWalletAddress();
  const { file, journalFile } = destinationPaths({ file: fileIn, journalFile: journalIn });
  let loaded = null;
  let journalError = null;
  try { loaded = loadSkimJournal(journalFile); } catch (e) { journalError = e.message; }
  const pending = loaded ? reduceSkimJournal(loaded.events).filter((s) => s.status === "pending").length : 0;
  const why = destinationChangeRefusal({
    journalError, journalCorrupt: loaded?.corrupt ?? 0, pendingSkims: pending,
    sendInFlight: busy.sendInFlight === true || isSkimSendInProgress(), confirmInFlight: busy.confirmInFlight === true, proposeInFlight: busy.proposeInFlight === true,
  });
  if (why) { log("skim_warn", `[SKIM] destination change refused: ${why}`); return { ok: false, journalled: false, error: why }; }
  const current = getSkimDestination({ env, walletAddress: wa, file, journalFile, now });
  const js = journalDestinationState(loaded.events);

  let target;
  if (change?.kind === "set") {
    const p = parseSkimAddressInput(change.to, { walletAddress: wa });
    if (!p.ok) return { ok: false, journalled: false, error: `new destination refused: ${p.error}` };
    target = p.address;
  } else if (change?.kind === "reset") {
    if (!current.mismatch && current.source === "env") return { ok: false, journalled: false, error: "there is no Telegram-set destination to reset" };
    const envDest = getEnvSkimDestination({ env, walletAddress: wa });
    if (!envDest.ok) return { ok: false, journalled: false, error: `the .env destination is not usable: ${envDest.error}` };
    if (envDest.address !== change.to) return { ok: false, journalled: false, error: "the .env destination changed since the reset was requested — start again" };
    target = envDest.address;
  } else {
    return { ok: false, journalled: false, error: "unknown change" };
  }
  if (!current.mismatch && current.address && target === current.address) return { ok: false, journalled: false, error: "that is already the destination" };

  const fromMasked = current.masked || (current.mismatch ? "unknown (file mismatch)" : "none");
  const line = buildDestinationChangeLine({ kind: change.kind, to: change.kind === "reset" ? null : target, fromMasked, now, holdHours, existingHoldUntilMs: js.holdUntilMs });
  const toMasked = maskAddress(target);
  const holdUntilMs = Date.parse(line.hold_until);
  const base = { kind: change.kind, fromMasked, toMasked, holdUntil: line.hold_until, holdUntilMs, source: change.kind === "reset" ? "env" : "telegram" };

  // 1. the journal line — the truth. Never rolled back.
  let journalErr = null;
  try { appendSkimJournal(line, journalFile, mirror); } catch (e) { journalErr = e; }
  let journalled = journalErr == null;
  if (journalErr) {
    // A write can land and its fsync fail: look for the line before saying anything.
    try { journalled = journalDestinationChanges(loadSkimJournal(journalFile).events).some((c) => c.set_at === line.set_at && c.to === line.to); } catch { journalled = false; }
    if (!journalled) {
      log("skim_error", `[SKIM] destination change not applied — the skim journal could not be written (${maskAddressesIn(journalErr.message)})`);
      return { ok: false, journalled: false, ...base, error: `the skim journal could not be written (${maskAddressesIn(journalErr.message)}) — nothing changed` };
    }
  }
  try { cancelProposal(); } catch { /* the hold refuses any proposal anyway */ }

  // 2. the file, from the journal. A line that is in the journal but whose fsync failed still
  // decides: the file follows it (if the line is lost later, the file no longer matches → refuse).
  const w = writeDestinationFileFromJournal(file, journalFile);
  if (journalErr && w.written) w.warning = [`the journal write was not confirmed durable (${maskAddressesIn(journalErr.message)})`, w.warning].filter(Boolean).join("; ");
  const after = getSkimDestination({ env, walletAddress: wa, file, journalFile, now });
  const inEffect = !after.mismatch && (after.address === target);
  if (!w.written || !inEffect) {
    const err = `change journalled but the file could not be written (${w.error || "it does not match the journal"}) — the skimmer refuses until you re-send the command`;
    log("skim_error", `[SKIM] destination change ${fromMasked} → ${toMasked}: ${err}`);
    return { ok: false, journalled: true, ...base, error: err };
  }
  log("skim", `[SKIM] destination changed ${fromMasked} → ${toMasked} (telegram${change.kind === "reset" ? ", reset to .env" : ""}), hold until ${fmtWib(holdUntilMs, "datetime")}${w.warning ? ` — warning: ${w.warning}` : ""}`);
  const stillRefused = integrityAfter({ journalFile, mirror, getBaseline });
  if (stillRefused) log("skim_warn", `[SKIM] destination change journalled, but the skimmer still refuses: ${stillRefused}`);
  return { ok: true, journalled: true, ...base, warning: w.warning || null, stillRefused };
}

/** After a destination change / verification: the journal-integrity verdict every skim checks (null = fine, else why it still refuses). */
function integrityAfter({ journalFile, mirror, getBaseline }) {
  let baseline = {};
  try { baseline = getBaseline ? (getBaseline() || {}) : {}; } catch { /* baseline unknown: check journal ↔ mirror only */ }
  const js = skimJournalState({ journalFile, mirror, baseline });
  return js.integrity.ok ? null : maskAddressesIn(js.integrity.reason);
}

/**
 * /skim address verified: a destination_verified journal line for the newest change, then
 * the file from the journal (journal first, as for a change). Re-sending it after a failed
 * file write rewrites the file. → { ok, masked, warning? } | { ok:false, error }
 */
export function applySkimDestinationVerified({ file: fileIn, journalFile: journalIn, mirror = defaultSkimMirror, env = process.env, walletAddress, now = Date.now(), getBaseline = getBaselineState } = {}) {
  const wa = walletAddress ?? getWalletAddress();
  const { file, journalFile } = destinationPaths({ file: fileIn, journalFile: journalIn });
  let loaded;
  try { loaded = loadSkimJournal(journalFile); } catch (e) { return { ok: false, error: `the skim journal cannot be read (${maskAddressesIn(e.message)})` }; }
  if (loaded.corrupt > 0) return { ok: false, error: `the skim journal has ${loaded.corrupt} unreadable line(s)` };
  const state = journalDestinationState(loaded.events);
  const current = getSkimDestination({ env, walletAddress: wa, file, journalFile, now });
  const destEvents = loaded.events.filter((e) => e?.type === "destination_change" || e?.type === "destination_verified");
  const last = destEvents[destEvents.length - 1];
  const lastIsVerifyOfNewest = !!(state.newest && last?.type === "destination_verified" && last.change_set_at === state.newest.set_at && last.to === state.newest.to);
  const why = verifyRefusal({ state, current, skims: reduceSkimJournal(loaded.events), lastIsVerifyOfNewest });
  if (why) return { ok: false, error: maskAddressesIn(why) };
  const masked = maskAddress(state.newest.to);
  if (!state.verified) {
    try {
      appendSkimJournal({ type: "destination_verified", at: new Date(now).toISOString(), to: state.newest.to, to_masked: masked, change_set_at: state.newest.set_at, source: "telegram" }, journalFile, mirror);
    } catch (e) {
      const there = journalDestinationState(loadSkimJournal(journalFile).events).verified;
      if (!there) return { ok: false, error: `the skim journal could not be written (${maskAddressesIn(e.message)}) — not verified` };
    }
  }
  const w = writeDestinationFileFromJournal(file, journalFile);
  const after = getSkimDestination({ env, walletAddress: wa, file, journalFile, now });
  if (!w.written || after.mismatch) {
    const err = `verification journalled but the file could not be written (${w.error || "it does not match the journal"}) — the skimmer refuses until you re-send /skim address verified`;
    log("skim_error", `[SKIM] destination ${masked}: ${err}`);
    return { ok: false, error: err };
  }
  log("skim", `[SKIM] destination ${masked} verified by the operator${w.warning ? ` — warning: ${w.warning}` : ""}`);
  const stillRefused = integrityAfter({ journalFile, mirror, getBaseline });
  return { ok: true, masked, warning: w.warning || null, stillRefused };
}

// ─── Postgres mirror (kv_store "skim-ledger") ─────────────────────
const _mirrorStore = makeDocStore("skim-ledger", dataPath("skim-ledger.json"), () => ({ entries: {} }));
export const defaultSkimMirror = {
  get: () => _mirrorStore.get(),
  set: (doc) => _mirrorStore.set(doc),
};

function mirrorEvent(mirror, event) {
  if (!mirror) return;
  const doc = mirror.get() || { entries: {} };
  if (event?.type === "destination_change" || event?.type === "destination_verified") {
    // The mirror (pg backups) holds the change masked; the full address stays in the local journal.
    const changes = Array.isArray(doc.destination_changes) ? doc.destination_changes : [];
    mirror.set({ ...doc, destination_changes: [...changes, maskedDestinationLine(event)] });
    return;
  }
  if (typeof event?.signature !== "string" || !event.signature) return;
  const entries = { ...(doc.entries || {}) };
  const prev = entries[event.signature] || {};
  if (prev.status === "landed" && event.event !== "landed") return; // landed is final
  entries[event.signature] = {
    ...prev,
    status: event.event,
    amount_sol: event.amount_sol ?? prev.amount_sol ?? null,
    created_at: prev.created_at ?? (event.event === "pending" ? event.at : null),
    updated_at: event.at,
    ...(event.destination_masked ? { destination_masked: event.destination_masked } : {}),
    ...(Number.isFinite(Number(event.last_valid_block_height)) && event.last_valid_block_height != null ? { last_valid_block_height: Number(event.last_valid_block_height) } : {}),
  };
  mirror.set({ ...doc, entries });
}

// ─── journal (append-only, fsync'd) ────────────────────────────────
export function skimJournalPath() { return dataPath("skim-journal.jsonl"); }

/** { exists, events, corrupt } — an unreadable line is COUNTED (integrity refuses), never skipped silently. */
export function loadSkimJournal(file = skimJournalPath()) {
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch (e) { if (e.code === "ENOENT") return { exists: false, events: [], corrupt: 0 }; throw e; }
  const events = [];
  const badLines = [];
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    try { events.push(JSON.parse(line)); } catch { badLines.push({ line: i + 1, preview: line.slice(0, 80) }); }
  });
  return { exists: true, events, corrupt: badLines.length, badLines, lineCount: lines.filter((l) => l.trim()).length };
}

export function readSkimJournal(file) { return loadSkimJournal(file).events; }

function fsyncDir(dir) {
  let fd;
  try { fd = fs.openSync(dir, "r"); fs.fsyncSync(fd); } catch (e) {
    if (!["EISDIR", "EINVAL", "EPERM", "EBADF", "ENOTSUP"].includes(e.code)) throw e;
  } finally { if (fd != null) try { fs.closeSync(fd); } catch { /* */ } }
}

/** Append one event: a newline first when the file does not end with one (torn write), fsync, mirror. */
export function appendSkimJournal(event, file = skimJournalPath(), mirror = defaultSkimMirror) {
  const created = !fs.existsSync(file);
  let needsNewline = false;
  if (!created) {
    const size = fs.statSync(file).size;
    if (size > 0) {
      const rfd = fs.openSync(file, "r");
      try {
        const b = Buffer.alloc(1);
        fs.readSync(rfd, b, 0, 1, size - 1);
        needsNewline = b[0] !== 0x0a;
      } finally { fs.closeSync(rfd); }
    }
  }
  const fd = fs.openSync(file, "a", 0o600);
  try {
    fs.writeSync(fd, `${needsNewline ? "\n" : ""}${JSON.stringify(event)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (created) fsyncDir(path.dirname(file));
  try { mirrorEvent(mirror, event); } catch (e) { log("skim_warn", `[SKIM] Postgres mirror update failed: ${e.message}`); }
}

export function getSkims(file) { return reduceSkimJournal(readSkimJournal(file)); }

/** A destination_change / destination_verified line, masked: { at, kind, from_masked, to_masked, source, hold_until }. */
function maskedDestinationLine(e) {
  return {
    at: e.at, kind: e.type === "destination_verified" ? "verified" : (e.kind ?? null), from_masked: e.from_masked ?? null,
    to_masked: typeof e.to === "string" ? maskAddress(e.to) : "env", source: e.source ?? null, hold_until: e.hold_until ?? null,
  };
}
/** The journal's destination lines, masked (never the full address) — for the integrity check and the journal report. */
function maskedJournalChanges(events) {
  return (events || []).filter((e) => e?.type === "destination_change" || e?.type === "destination_verified").map(maskedDestinationLine);
}

/** Addresses a journal / baseline / mirror entry may have been sent to (its own, else .env or a journalled change). */
function entryDestinations(entry, { journalFile, env = process.env, walletAddress } = {}) {
  let events = [];
  try { events = loadSkimJournal(journalFile).events; } catch { /* no journalled changes */ }
  const envDest = getEnvSkimDestination({ env, walletAddress });
  return skimEntryDestinations(entry, { envAddress: envDest.ok ? envDest.address : null, journalEvents: events });
}

/** Journal health + skims + integrity against the mirror and the baseline. */
export function skimJournalState({ journalFile, mirror = defaultSkimMirror, baseline } = {}) {
  let loaded;
  try { loaded = loadSkimJournal(journalFile); } catch (e) {
    return { skims: [], integrity: { ok: false, reason: `skim journal unreadable: ${maskAddressesIn(e.message)}`, toBook: [] } };
  }
  const skims = reduceSkimJournal(loaded.events);
  let mirrorDoc = null;
  try { mirrorDoc = mirror?.get() ?? null; } catch (e) {
    return { skims, integrity: { ok: false, reason: `skim mirror unreadable: ${maskAddressesIn(e.message)}`, toBook: [] } };
  }
  const integrity = skimIntegrity({ journal: { exists: loaded.exists, corrupt: loaded.corrupt, skims, destinationChanges: maskedJournalChanges(loaded.events) }, mirror: mirrorDoc, baseline: baseline ?? {} });
  return { skims, integrity, exists: loaded.exists, corrupt: loaded.corrupt };
}

// ─── chain verdict for one signature ──────────────────────────────
async function chainVerdict(conn, skim, { forceTxLookup = false } = {}) {
  let st = null;
  try { st = (await conn.getSignatureStatuses([skim.signature], { searchTransactionHistory: true }))?.value?.[0] ?? null; }
  catch { return { verdict: "pending", st: null }; }
  let height = null;
  if (!st) { try { height = await conn.getBlockHeight("confirmed"); } catch { /* unknown */ } }
  let txLookup;
  if (!st && (forceTxLookup || needsTxLookup(skim, st, height))) {
    try { txLookup = await conn.getTransaction(skim.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }); }
    catch { txLookup = undefined; }
  }
  return { verdict: resolveSkimStatus(skim, st, height, { txLookup }), st, txLookup };
}

function recordVerdict({ skim, verdict, st, txLookup, journalFile, mirror, getBaseline, saveBaseline, at }) {
  if (verdict === "landed") {
    appendSkimJournal({ event: "landed", signature: skim.signature, amount_sol: skim.amount_sol, at }, journalFile, mirror);
    if (getBaseline && saveBaseline) {
      const b = getBaseline();
      if (bookSkimWithdrawal(b, { signature: skim.signature, amountSol: skim.amount_sol, at: skim.created_at || at, destinationMasked: skim.destination_masked })) saveBaseline(b);
    }
  } else if (verdict === "failed") {
    const why = st?.err || txLookup?.meta?.err ? "on-chain error" : "blockhash expired and the primary RPC does not know the transaction";
    appendSkimJournal({ event: "failed", signature: skim.signature, amount_sol: skim.amount_sol, at, why }, journalFile, mirror);
  }
}

// ─── pending resolution ───────────────────────────────────────────
/**
 * Resolve every pending skim against the chain (primary RPC). Landed → booked as a
 * baseline withdrawal (idempotent). Failed only on an on-chain error, or when the
 * signature is unknown after the blockhash expired AND getTransaction does not find it.
 * Also books LANDED journal entries the baseline lacks. Returns { landed, failed, pending }.
 */
export async function resolvePendingSkims(deps = {}) {
  const { conn = getConnection(), journalFile, mirror = defaultSkimMirror, getBaseline, saveBaseline, now = () => Date.now() } = deps;
  const skims = getSkims(journalFile);
  const out = { landed: [], failed: [], pending: [] };
  if (getBaseline && saveBaseline) {
    const b = getBaseline();
    let added = false;
    for (const s of skims.filter((x) => x.status === "landed")) {
      if (bookSkimWithdrawal(b, { signature: s.signature, amountSol: s.amount_sol, at: s.created_at || s.resolved_at, destinationMasked: s.destination_masked })) added = true;
    }
    if (added) { saveBaseline(b); log("skim", "[SKIM] booked landed journal skim(s) missing from the baseline"); }
  }
  for (const s of skims.filter((x) => x.status === "pending")) {
    const { verdict, st, txLookup } = await chainVerdict(conn, s);
    const at = new Date(now()).toISOString();
    if (verdict === "pending") { out.pending.push(s); continue; }
    recordVerdict({ skim: s, verdict, st, txLookup, journalFile, mirror, getBaseline, saveBaseline, at });
    log("skim", `[SKIM] pending skim ${maskAddress(s.signature)} ◎${s.amount_sol} → ${verdict.toUpperCase()}`);
    out[verdict].push(s);
  }
  return out;
}

/**
 * Operator: /skim resolve <signature> landed|failed. Written only when the chain's own
 * verdict (statuses + getTransaction on the primary) agrees.
 */
export async function operatorResolveSkim(signature, claim, deps = {}) {
  const { conn = getConnection(), journalFile, mirror = defaultSkimMirror, getBaseline = getBaselineState, saveBaseline = saveBaselineState, now = () => Date.now(), env = process.env, walletAddress = getWalletAddress() } = deps;
  const skim = getSkims(journalFile).find((s) => s.signature === signature);
  if (!skim || skim.status !== "pending") return { ok: false, error: operatorResolveRefusal(claim, "pending", skim) };
  const { verdict, st, txLookup } = await chainVerdict(conn, skim, { forceTxLookup: true });
  const refusal = operatorResolveRefusal(claim, verdict, skim);
  if (refusal) return { ok: false, error: refusal, chainVerdict: verdict };
  if (verdict === "landed") {
    // The landed transfer must be the entry's own: to its recorded destination (else .env / a journalled change), for its amount.
    let parsed;
    try { parsed = await conn.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }); }
    catch (e) { return { ok: false, error: `the primary RPC could not be read: ${maskAddressesIn(e.message)}`, chainVerdict: verdict }; }
    const why = adoptRefusal({ parsedTx: parsed, walletAddress, destination: entryDestinations(skim, { journalFile, env, walletAddress }), expectedLamports: Math.round(Number(skim.amount_sol) * LAMPORTS_PER_SOL) });
    if (why) return { ok: false, error: maskAddressesIn(why), chainVerdict: verdict };
  }
  recordVerdict({ skim, verdict, st, txLookup, journalFile, mirror, getBaseline, saveBaseline, at: new Date(now()).toISOString() });
  log("skim", `[SKIM] operator resolved ${maskAddress(signature)} as ${verdict} (chain agrees)`);
  return { ok: true, verdict, skim };
}

// ─── the one send function ────────────────────────────────────────
let _sendLock = false;
/** True while sendSkim runs (from its first check to its last poll). */
export function isSkimSendInProgress() { return _sendLock; }

/**
 * Send exactly `amountSol` to the env destination. The caller has already decided and
 * consumed a proposal. Returns { status: "landed"|"failed"|"unknown"|"dry_run"|"refused",
 * signature?, amountSol, error?, remainingSol? }.
 *
 * deps.acquire()      SYNC: claim the close slot + pause new poller ticks; throws when busy
 * deps.release()      idempotent; called at the broadcast and on every exit
 * deps.waitReady(ms)  resolves once no poller tick is running (bounded by the deadline)
 * deps.preSendCheck() reasons the send must not happen now ([] = go)
 * expectedFreeSol     the decision's free SOL; the final balance must match within tolerance
 */
export async function sendSkim({ amountSol, proposalId = null, reserveSol, reason = "profit_skim", expectedFreeSol = null, expectedDestination = null }, deps = {}) {
  const {
    conn = getConnection(),
    wallet = getWallet(),
    // where the resolver reads the destination (tests: a temp data dir); the resolver itself is not injectable
    destinationFile,
    env = process.env,
    walletAddress = wallet?.publicKey?.toBase58?.() ?? null,
    journalFile,
    mirror = defaultSkimMirror,
    getBaseline,
    saveBaseline,
    persist = async () => {},
    dryRun = process.env.DRY_RUN === "true",
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    now = () => Date.now(),
    acquire = () => {},
    release = () => {},
    waitReady = async () => {},
    preSendCheck = () => [],
    finalCheck = () => [],   // last check, inside the claim, immediately before the journal write (disable / cancel)
    onBroadcast = () => {},  // called once the broadcast was attempted (the point of no return has passed)
    deadlineMs = SKIM_PRE_BROADCAST_DEADLINE_MS,
    balanceTolerance = 0.01,
  } = deps;
  let released = false;
  const releaseOnce = () => { if (released) return; released = true; try { release(); } catch { /* never fatal */ } };
  const refused = (error) => { const e = maskAddressesIn(String(error)); log("skim_warn", `[SKIM] send refused: ${e}`); return { status: "refused", amountSol, error: e }; };
  const testTransferCap = () => (env === process.env ? currentTestTransferSol() : testTransferSolFromEnv(env));
  // The effective destination, re-resolved fresh each time (journal + file + hold + on-chain account).
  const resolveDestination = () => verifySkimDestinationOnChain({ conn, fresh: true, env, file: destinationFile, journalFile, walletAddress });
  if (_sendLock) return refused("another skim is being sent");
  _sendLock = true;
  let intentWritten = null;
  let acquired = false;
  // The proposal's destination must still be the effective one, and pass every check.
  const destinationRefusal = (d) => {
    if (!d?.ok) return `destination refused: ${d?.error || "unknown"}`;
    if (d.holdActive) return "the destination is on hold after a change";
    if (!expectedDestination) return "no proposal destination given";
    if (d.address !== expectedDestination) return "the destination changed since the proposal — nothing sent; ask for a new proposal";
    // Test-transfer rule: an unverified (Telegram-set) destination gets ONE transfer of the fixed
    // test amount (computed here, never taken from the caller), and none after one is pending or landed.
    if (d.verified === false) {
      const cap = testTransferCap();
      if (Math.round(Number(amountSol) * LAMPORTS_PER_SOL) > Math.round(cap * LAMPORTS_PER_SOL)) return `the destination is unverified — only one test transfer of ◎${cap} is allowed until /skim address verified`;
      let sk = [];
      try { sk = getSkims(journalFile); } catch { return "the skim journal cannot be read"; }
      if (testTransfersSince(sk, d.address, d.changed_at).length > 0) return "test transfer already sent — check it arrived, then /skim address verified";
    }
    return null;
  };
  try {
    const first = await withDeadline(resolveDestination(), 10_000, "destination check");
    const firstWhy = destinationRefusal(first);
    if (firstWhy) return refused(firstWhy);
    const lamports = Math.round(Number(amountSol) * LAMPORTS_PER_SOL);
    if (!Number.isSafeInteger(lamports) || lamports < 0.01 * LAMPORTS_PER_SOL) return refused("amount must be at least ◎0.01");
    if (!(Number(reserveSol) >= 0)) return refused("reserve not given");
    const js = skimJournalState({ journalFile, mirror, baseline: getBaseline ? getBaseline() : {} });
    if (!js.integrity.ok) return refused(js.integrity.reason);
    if (js.skims.some((s) => s.status === "pending")) return refused("an earlier skim is unresolved");

    // ── pre-broadcast window: claimed synchronously, everything under the deadline ──
    try { acquire(); acquired = true; } catch (e) { return refused(e.message || "busy"); }
    const started = Date.now();
    const left = () => Math.max(1, deadlineMs - (Date.now() - started));
    let prepared;
    try {
      prepared = await withDeadline((async () => {
        await waitReady(left());
        const busy = preSendCheck();
        if (busy.length) { const e = new Error(`busy: ${busy.join(", ")}`); e.refuse = true; throw e; }
        // Inside the claim: re-resolve the destination (override file, hold, on-chain account) once more.
        const d = await resolveDestination();
        const dWhy = destinationRefusal(d);
        if (dWhy) { const e = new Error(dWhy); e.refuse = true; throw e; }
        const balanceLamports = await conn.getBalance(wallet.publicKey, "confirmed");
        if (expectedFreeSol != null && Math.abs(balanceLamports / LAMPORTS_PER_SOL - Number(expectedFreeSol)) > balanceTolerance) {
          const e = new Error(`wallet balance ◎${(balanceLamports / LAMPORTS_PER_SOL).toFixed(4)} no longer matches the decision's ◎${Number(expectedFreeSol).toFixed(4)}`); e.refuse = true; throw e;
        }
        const feeLamports = BASE_FEE_LAMPORTS + Math.ceil((PRIORITY_FEE_MICRO_LAMPORTS * COMPUTE_UNIT_LIMIT) / 1e6);
        if (balanceLamports - lamports - feeLamports < Math.round(Number(reserveSol) * LAMPORTS_PER_SOL)) {
          const e = new Error(`balance ◎${(balanceLamports / LAMPORTS_PER_SOL).toFixed(4)} (primary RPC) would fall under the ◎${reserveSol} reserve`); e.refuse = true; throw e;
        }
        const tx = new Transaction();
        tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }));
        tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_FEE_MICRO_LAMPORTS }));
        tx.add(SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: new PublicKey(d.address), lamports }));
        const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
        tx.recentBlockhash = blockhash;
        tx.feePayer = wallet.publicKey;
        tx.sign(wallet);
        let sim;
        try { sim = await conn.simulateTransaction(new VersionedTransaction(tx.compileMessage()), { sigVerify: false, commitment: "confirmed" }); }
        catch (e) { const err = new Error(`simulation could not run: ${e.message}`); err.refuse = true; throw err; }
        if (sim?.value?.err) { const e = new Error(`simulation failed: ${JSON.stringify(sim.value.err)}`); e.refuse = true; throw e; }
        return { tx, signature: bs58.encode(tx.signature), lastValidBlockHeight, balanceLamports, feeLamports, destination: d };
      })(), deadlineMs, "pre-broadcast checks");
    } catch (e) {
      return refused(e.deadline ? `${e.message} — nothing sent` : e.message);
    }
    const { tx, signature, lastValidBlockHeight, balanceLamports, feeLamports, destination } = prepared;
    const amount = lamports / LAMPORTS_PER_SOL;

    // Last chance to stop: the operator turned the skimmer off or cancelled while the checks ran.
    let stop;
    try { stop = finalCheck(); } catch (e) { stop = [`final check failed: ${e.message}`]; }
    if (Array.isArray(stop) && stop.length) return refused(stop.join(", "));

    if (dryRun) {
      log("skim", `[SKIM] DRY_RUN: would send ◎${amount.toFixed(4)} to ${destination.masked} (simulation ok) — nothing sent`);
      return { status: "dry_run", amountSol: amount };
    }

    // Durable intent BEFORE the send: the signature is known, so a crash after this
    // line leaves a pending record that blocks any further skim until it is resolved.
    const createdAt = new Date(now()).toISOString();
    try {
      appendSkimJournal({ event: "pending", signature, amount_sol: amount, at: createdAt, last_valid_block_height: lastValidBlockHeight, proposal_id: proposalId, destination: destination.address, destination_masked: destination.masked, destination_source: destination.source ?? null, reason }, journalFile, mirror);
    } catch (e) {
      return refused(`could not write the skim journal: ${e.message}`);
    }
    intentWritten = signature;
    try {
      await withDeadline(persist(), left(), "state flush");
    } catch (e) {
      // Not broadcast: the signed transaction is discarded, so the intent is closed as failed.
      appendSkimJournal({ event: "failed", signature, amount_sol: amount, at: new Date(now()).toISOString(), why: "not sent: state flush failed or timed out" }, journalFile, mirror);
      intentWritten = null;
      return refused(`state flush failed before the send: ${e.message}`);
    }

    log("skim", `[SKIM] sending ◎${amount.toFixed(4)} to ${destination.masked} (proposal ${proposalId || "-"}, tx ${maskAddress(signature)})`);
    try {
      await withDeadline(conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3 }), 15_000, "broadcast");
    } catch (e) {
      // Unknown: the RPC may still have forwarded it. Stays pending; resolved by status.
      log("skim_error", `[SKIM] send call failed for ${maskAddress(signature)}: ${e.message} — left pending, resolved by signature status`);
    }
    releaseOnce(); // the claim covers only up to the broadcast
    try { onBroadcast(signature); } catch { /* never fatal */ }

    const pollStart = now();
    for (;;) {
      const { verdict, st, txLookup } = await chainVerdict(conn, { signature, last_valid_block_height: lastValidBlockHeight });
      const at = new Date(now()).toISOString();
      if (verdict === "landed") {
        recordVerdict({ skim: { signature, amount_sol: amount, created_at: createdAt, destination_masked: destination.masked }, verdict, st, txLookup, journalFile, mirror, getBaseline, saveBaseline, at });
        const remainingSol = Math.max(0, (balanceLamports - lamports - feeLamports) / LAMPORTS_PER_SOL);
        log("skim", `[SKIM] landed ◎${amount.toFixed(4)} to ${destination.masked}, tx ${signature}`);
        return { status: "landed", signature, amountSol: amount, destinationMasked: destination.masked, remainingSol: Math.round(remainingSol * 1e4) / 1e4 };
      }
      if (verdict === "failed") {
        recordVerdict({ skim: { signature, amount_sol: amount }, verdict, st, txLookup, journalFile, mirror, getBaseline, saveBaseline, at });
        const why = maskAddressesIn(st?.err ? `on-chain error ${JSON.stringify(st.err)}` : "blockhash expired without the transaction landing");
        log("skim_error", `[SKIM] ${maskAddress(signature)} failed: ${why}`);
        return { status: "failed", signature, amountSol: amount, error: why };
      }
      if (now() - pollStart > CONFIRM_MAX_MS) {
        log("skim_error", `[SKIM] ${maskAddress(signature)} unconfirmed after ${CONFIRM_MAX_MS / 1000}s — left pending; no skim until it resolves`);
        return { status: "unknown", signature, amountSol: amount, error: "not confirmed yet — it may still land; the skimmer is blocked until it resolves" };
      }
      await sleep(CONFIRM_POLL_MS);
    }
  } catch (e) {
    if (intentWritten) {
      log("skim_error", `[SKIM] ${maskAddress(intentWritten)}: ${e.message} after the intent was journaled — left pending; no skim until it resolves`);
      return { status: "unknown", signature: intentWritten, amountSol, error: maskAddressesIn(e.message) };
    }
    log("skim_error", `[SKIM] send failed before broadcast: ${e.message}`);
    return { status: "refused", amountSol, error: maskAddressesIn(e.message) };
  } finally {
    if (acquired) releaseOnce();
    _sendLock = false;
  }
}

// ─── inputs for the decision ──────────────────────────────────────
/**
 * Positions as the decision sees them (RPC path only; closed / unready rows flagged).
 * getMyPositions({force}) shares a read already in flight, which may have started before
 * the caller's first balance read (a close landing in between would be counted twice:
 * the position at cost + its proceeds in free SOL). So: the first call is awaited and
 * discarded — any read in flight after it started later — then a second call is used,
 * and every listed position account must still exist on the primary RPC.
 */
export async function readSkimPositions({ conn = getConnection(), getPositions = null, getTracked = getTrackedPosition } = {}) {
  const load = getPositions || (async () => (await import("./dlmm.js")).getMyPositions({ force: true, silent: true }));
  await load();
  const res = await load();
  if (!res || res.error || !Array.isArray(res.positions)) return { valuationComplete: false, source: res?.source ?? null, positions: [] };
  const rows = res.positions.filter((p) => p?.position);
  if (rows.length) {
    const infos = await conn.getMultipleAccountsInfo(rows.map((p) => new PublicKey(p.position)), "confirmed");
    const gone = rows.filter((p, i) => !infos?.[i]);
    if (gone.length) return { valuationComplete: false, invalidReason: `a listed position account no longer exists (${maskAddress(gone[0].position)} closed during the read)`, source: res.source ?? null, positions: [] };
  }
  const solPrice = getSolPriceUsd();
  const positions = rows.map((p) => {
    // total_value_usd carries SOL under solMode (the unit landmine — see CLAUDE.md).
    const raw = Number(p.total_value_usd);
    const valueSol = config.management?.solMode ? raw : (solPrice > 0 ? raw / solPrice : NaN);
    const tracked = getTracked(p.position);
    return { position: p.position, valueSol, costSol: Number(tracked?.amount_sol), closed: tracked?.closed === true, ready: p.pnl_management_ready !== false };
  });
  return { valuationComplete: true, source: res.source ?? null, positions };
}

/** The primary connection and the slot of a fresh balance read (for the bounded pre-skim scan). */
export async function primaryBalanceSlot() {
  const conn = getConnection();
  const b = await conn.getBalanceAndContext(getWallet().publicKey, "confirmed");
  return { conn, slot: b?.context?.slot };
}

/** The live skim config (thresholds from config.autoSkim, confirmation switch + ceilings from the env). */
export function currentSkimConfig() {
  return { ...skimConfig(config.autoSkim || {}, { env: process.env, gasReserveSol: config.management?.gasReserve ?? 0 }), testTransferSol: currentTestTransferSol() };
}

let _testTransferSol = null;
/** The test-transfer amount: SKIM_TEST_TRANSFER_SOL, or .env AUTO_SKIM_TEST_TRANSFER_SOL within [0.01, 0.1]; read once. */
export function currentTestTransferSol() {
  if (_testTransferSol == null) _testTransferSol = testTransferSolFromEnv(process.env);
  return _testTransferSol;
}

function untrackedSwapFigures(baseline) {
  const swaps = Array.isArray(baseline?.token_swaps) ? baseline.token_swaps : [];
  const known = new Set();
  try { for (const p of getTrackedPositions(false)) if (p?.base_mint) known.add(p.base_mint); } catch { /* */ }
  const evictedRaw = baseline?.token_swaps_evicted_sol;
  const evicted = evictedRaw == null ? null : Number(evictedRaw);
  return {
    untrackedSwapSolTotal: untrackedSwapSol(swaps, known) + (Number.isFinite(evicted) ? evicted : 0),
    tokenSwapCount: swaps.length,
    tokenSwapsEvictedSol: evicted,
  };
}

/**
 * The decision with live inputs, in this order: resolve pending skims → free SOL from
 * the PRIMARY RPC with its context slot → (optional) deposit scan on the primary with
 * minContextSlot = that slot → positions (RPC path) → free SOL again. The lower balance
 * is used; the decision refuses when the two differ by more than the tolerance.
 *   runScan({ conn, minContextSlot }) → true when the scan completed
 *   baselineFresh  a result the caller already has (skips runScan)
 *   inFlight       array, or a function read last
 */
export async function evaluateSkim({ inFlight = [], runScan = null, baselineFresh: presetFresh } = {}) {
  const cfg = currentSkimConfig();
  const conn = getConnection();
  const destination = await verifySkimDestinationOnChain({ conn });
  let resolved = null;
  try {
    resolved = await resolvePendingSkims({ conn, getBaseline: getBaselineState, saveBaseline: saveBaselineState });
  } catch (e) {
    log("skim_warn", `[SKIM] pending resolution failed: ${e.message}`);
  }
  let wallet = { freeSol: NaN, valuationComplete: false, positions: [] };
  let baselineFresh = presetFresh === undefined ? null : presetFresh === true;
  try {
    const pk = getWallet().publicKey;
    const b1 = await conn.getBalanceAndContext(pk, "confirmed");
    if (typeof runScan === "function") {
      try { baselineFresh = (await runScan({ conn, minContextSlot: b1?.context?.slot })) === true; } catch { baselineFresh = false; }
    }
    const pos = await readSkimPositions({ conn });
    const after = await conn.getBalance(pk, "confirmed");
    const before = Number(b1?.value) / LAMPORTS_PER_SOL;
    wallet = { ...pos, freeSolBefore: before, freeSolAfter: after / LAMPORTS_PER_SOL, freeSol: Math.min(before, after / LAMPORTS_PER_SOL) };
  } catch (e) {
    log("skim_warn", `[SKIM] wallet read failed: ${e.message}`);
  }
  const baseline = getBaselineState();
  const js = skimJournalState({ baseline });
  const decision = computeSkimDecision({
    cfg, destination, baseline, skims: js.skims, integrity: js.integrity, baselineFresh, wallet,
    ...untrackedSwapFigures(baseline),
    inFlight: typeof inFlight === "function" ? inFlight() : inFlight, now: Date.now(),
  });
  return { cfg, destination, decision, resolved, integrity: js.integrity, skims: js.skims };
}

/**
 * Operator: /skim adopt <signature> — journal a skim the journal does not know:
 *   - a baseline withdrawal flagged skim / with a legacy reason: written as landed ONLY when
 *     the primary RPC shows a successful transfer from the bot wallet to the configured
 *     destination for the booked amount (adoptRefusal);
 *   - a signature only the Postgres mirror lists: written with the chain's own verdict
 *     (landed — also checked by adoptRefusal — or failed: on-chain error / expired and
 *     unknown to the primary), never pending.
 */
export async function operatorAdoptSkim(signature, deps = {}) {
  const {
    conn = getConnection(), journalFile, mirror = defaultSkimMirror, baseline = getBaselineState(),
    walletAddress = getWalletAddress(), destination: destDep, env = process.env, now = () => Date.now(),
  } = deps;
  const loaded = loadSkimJournal(journalFile);
  const known = new Set(reduceSkimJournal(loaded.events).map((s) => s.signature));
  if (known.has(signature)) return { ok: false, error: "the journal already has that signature" };
  const w = (baseline?.withdrawals || []).find((x) => x?.signature === signature);
  const m = (mirror?.get?.()?.entries || {})[signature];
  if (!w && !m) return { ok: false, error: "that signature is neither a baseline withdrawal nor in the Postgres mirror" };
  const amountSol = Number(w?.amount ?? m?.amount_sol);
  // Checked against the entry's own destination; without one, the .env address or a journalled change (narrowed by a recorded mask).
  const allowed = destDep?.address ? [destDep.address]
    : skimEntryDestinations({ destination: w?.destination ?? null, destination_masked: m?.destination_masked ?? null }, { envAddress: (() => { const e = getEnvSkimDestination({ env, walletAddress }); return e.ok ? e.address : null; })(), journalEvents: loaded.events });
  if (!allowed.length) return { ok: false, error: "no destination to check it against (.env PIONEX_DEPOSIT_ADDRESS unusable and no journalled destination change)" };
  let parsed;
  try { parsed = await conn.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }); }
  catch (e) { return { ok: false, error: `the primary RPC could not be read: ${maskAddressesIn(e.message)}` }; }
  const at = new Date(now()).toISOString();
  const createdAt = w?.timestamp || m?.created_at || at;
  if (w || (parsed && !parsed.meta?.err)) {
    const why = adoptRefusal({ parsedTx: parsed, walletAddress, destination: allowed, expectedLamports: Number.isFinite(amountSol) ? Math.round(amountSol * LAMPORTS_PER_SOL) : NaN });
    if (why) return { ok: false, error: maskAddressesIn(why) };
    const sentTo = (parsed.transaction?.message?.instructions || []).map((ix) => ix.parsed?.info?.destination).find((d) => allowed.includes(d)) || null;
    appendSkimJournal({ event: "pending", signature, amount_sol: amountSol, at: createdAt, last_valid_block_height: null, proposal_id: null, destination: sentTo, destination_masked: sentTo ? maskAddress(sentTo) : null, reason: "adopted" }, journalFile, mirror);
    appendSkimJournal({ event: "landed", signature, amount_sol: amountSol, at, why: "adopted by the operator, chain-verified" }, journalFile, mirror);
    log("skim", `[SKIM] operator adopted ${maskAddress(signature)} ◎${amountSol} as LANDED (chain-verified transfer to ${sentTo ? maskAddress(sentTo) : "?"})`);
    return { ok: true, verdict: "landed", amountSol };
  }
  // mirror-only: the primary has it as failed on chain, or has nothing — then failed only once the blockhash expired
  const verdict = parsed?.meta?.err ? "failed"
    : (await chainVerdict(conn, { signature, last_valid_block_height: Number(m?.last_valid_block_height) || null }, { forceTxLookup: true })).verdict;
  if (verdict !== "failed") return { ok: false, error: `the chain says ${verdict} — not adopted` };
  appendSkimJournal({ event: "pending", signature, amount_sol: amountSol, at: createdAt, last_valid_block_height: null, reason: "adopted" }, journalFile, mirror);
  appendSkimJournal({ event: "failed", signature, amount_sol: amountSol, at, why: "adopted by the operator: the chain shows it never landed" }, journalFile, mirror);
  log("skim", `[SKIM] operator adopted ${maskAddress(signature)} as FAILED (chain-verified)`);
  return { ok: true, verdict: "failed", amountSol };
}

/** /skim journal check: what the journal, the mirror and the baseline hold. Read-only; never repairs. */
export function skimJournalReport({ journalFile, mirror = defaultSkimMirror, baseline = getBaselineState() } = {}) {
  const file = journalFile || skimJournalPath();
  let loaded;
  try { loaded = loadSkimJournal(file); } catch (e) { return { file, error: maskAddressesIn(e.message) }; }
  const skims = reduceSkimJournal(loaded.events);
  const sigs = new Set(skims.map((s) => s.signature));
  let mirrorDoc = null;
  try { mirrorDoc = mirror?.get?.() ?? null; } catch { /* reported below */ }
  const mirrorEntries = Object.entries(mirrorDoc?.entries || {}).map(([sig, e]) => ({ signature: sig, status: e?.status ?? null, amount_sol: e?.amount_sol ?? null, inJournal: sigs.has(sig) }));
  const unknownBooked = (baseline?.withdrawals || []).filter((w) => (w?.skim === true || LEGACY_SKIM_REASONS.has(w?.reason)) && !sigs.has(w.signature)).map((w) => ({ signature: w.signature, amount: w.amount, reason: w.reason ?? null }));
  const destinationChanges = maskedJournalChanges(loaded.events);
  const integrity = skimIntegrity({ journal: { exists: loaded.exists, corrupt: loaded.corrupt, skims, destinationChanges }, mirror: mirrorDoc, baseline });
  return { file, exists: loaded.exists, lineCount: loaded.lineCount ?? 0, badLines: loaded.badLines || [], skims, destinationChanges, mirrorEntries, unknownBooked, integrity };
}

/** sendSkim with the live dependencies (journal → state flush before the broadcast). */
export function executeSkim({ amountSol, proposalId, reserveSol, reason, expectedFreeSol, expectedDestination }, hooks = {}) {
  return sendSkim({ amountSol, proposalId, reserveSol, reason, expectedFreeSol, expectedDestination }, {
    getBaseline: getBaselineState,
    saveBaseline: saveBaselineState,
    persist: () => flushState(),
    ...hooks,
  });
}

/**
 * Operator-only setter (/skim set, /skim on|off): validates, updates the live config and
 * persists config.autoSkim.<field> to user-config.json. Never reachable from update_config.
 */
export function applySkimSetting(field, value, { userConfigPath = dataPath("user-config.json") } = {}) {
  // The FILE first (temp + rename); memory only after it succeeded — except "off", which
  // always takes effect in memory and, when the write failed, sets the off latch so a reload
  // of the stale file cannot turn the skimmer back on (2026-11-25, R1).
  config.autoSkim ??= {};
  const isOff = field === "enabled" && value === false;
  let error = null;
  try {
    let uc = {};
    if (fs.existsSync(userConfigPath)) {
      try { uc = JSON.parse(fs.readFileSync(userConfigPath, "utf8")); } catch (e) { throw new Error(`user-config.json unreadable: ${e.message}`); }
    }
    uc.autoSkim = { ...(uc.autoSkim && typeof uc.autoSkim === "object" ? uc.autoSkim : {}), [field]: value };
    const tmp = `${userConfigPath}.skim.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(uc, null, 2));
    fs.renameSync(tmp, userConfigPath);
  } catch (e) {
    error = e;
  }
  if (!error) {
    config.autoSkim[field] = value;
    if (field === "enabled") setSkimOffLatch(false);
    log("skim", `[SKIM] operator set autoSkim.${field} = ${JSON.stringify(value)}`);
    return { persisted: true, inMemory: true };
  }
  if (isOff) {
    config.autoSkim.enabled = false;
    setSkimOffLatch(true);
    log("skim_error", `[SKIM] operator turned the skimmer OFF but user-config.json could not be written (${error.message}) — off in memory, latched against reloads`);
    return { persisted: false, inMemory: true, error };
  }
  log("skim_error", `[SKIM] operator setting autoSkim.${field} not applied — user-config.json could not be written (${error.message})`);
  return { persisted: false, inMemory: false, error };
}
