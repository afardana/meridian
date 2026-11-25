/**
 * Profit skimmer — chain I/O (2026-11-25 rewrite). The decision is in ../skim-policy.js.
 *
 * - The destination is read from .env (PIONEX_DEPOSIT_ADDRESS) ONCE and cached for the
 *   life of the process; user-config.json, update_config, Telegram or the LLM cannot set
 *   or change it. It is checked for format at first read and against the chain (plain
 *   system wallet) by verifySkimDestinationOnChain().
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
import { log } from "../logger.js";
import { dataPath } from "../repo-root.js";
import { config } from "../config.js";
import { getSolPriceUsd } from "../sol-price.js";
import { makeDocStore } from "../db/doc-store.js";
import { getBaselineState, saveBaselineState, getTrackedPosition, getTrackedPositions, flushState } from "../state.js";
import { getWallet, getWalletAddress, getConnection } from "./wallet.js";
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
} from "../skim-policy.js";

const PRIORITY_FEE_MICRO_LAMPORTS = 50_000;
const COMPUTE_UNIT_LIMIT = 2_000;
const BASE_FEE_LAMPORTS = 5_000;
const CONFIRM_POLL_MS = 1_500;
const CONFIRM_MAX_MS = 120_000;
export const SKIM_PRE_BROADCAST_DEADLINE_MS = 30_000;

// ─── destination (env only, read once) ─────────────────────────────
let _destination = null;
let _destinationOnChain = null;

export function getSkimDestination({ env = process.env, walletAddress } = {}) {
  if (!_destination) {
    _destination = Object.freeze(checkSkimDestination(env.PIONEX_DEPOSIT_ADDRESS, { walletAddress: walletAddress ?? getWalletAddress() }));
  }
  return _destination;
}

/** Format check + on-chain account check, combined. Cached once the chain read succeeded. */
export async function verifySkimDestinationOnChain({ conn = null } = {}) {
  const dest = getSkimDestination();
  if (!dest.ok) return dest;
  if (_destinationOnChain?.ok) return _destinationOnChain;
  try {
    const info = await (conn || getConnection()).getAccountInfo(new PublicKey(dest.address), "confirmed");
    const acct = checkSkimDestinationAccount(info);
    _destinationOnChain = Object.freeze(acct.ok ? { ...dest, onChainChecked: true } : { ...dest, ok: false, error: acct.error });
  } catch (e) {
    return { ...dest, ok: false, error: `destination account could not be read: ${e.message}` };
  }
  return _destinationOnChain;
}

/** For tests only. */
export function _resetSkimDestinationCache() { _destination = null; _destinationOnChain = null; }

// ─── Postgres mirror (kv_store "skim-ledger") ─────────────────────
const _mirrorStore = makeDocStore("skim-ledger", dataPath("skim-ledger.json"), () => ({ entries: {} }));
export const defaultSkimMirror = {
  get: () => _mirrorStore.get(),
  set: (doc) => _mirrorStore.set(doc),
};

function mirrorEvent(mirror, event) {
  if (!mirror) return;
  const doc = mirror.get() || { entries: {} };
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
  let corrupt = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { corrupt++; }
  }
  return { exists: true, events, corrupt };
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

/** Journal health + skims + integrity against the mirror and the baseline. */
export function skimJournalState({ journalFile, mirror = defaultSkimMirror, baseline } = {}) {
  let loaded;
  try { loaded = loadSkimJournal(journalFile); } catch (e) {
    return { skims: [], integrity: { ok: false, reason: `skim journal unreadable: ${e.message}`, toBook: [] } };
  }
  const skims = reduceSkimJournal(loaded.events);
  let mirrorDoc = null;
  try { mirrorDoc = mirror?.get() ?? null; } catch (e) {
    return { skims, integrity: { ok: false, reason: `skim mirror unreadable: ${e.message}`, toBook: [] } };
  }
  const integrity = skimIntegrity({ journal: { exists: loaded.exists, corrupt: loaded.corrupt, skims }, mirror: mirrorDoc, baseline: baseline ?? {} });
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
  const { conn = getConnection(), journalFile, mirror = defaultSkimMirror, getBaseline = getBaselineState, saveBaseline = saveBaselineState, now = () => Date.now() } = deps;
  const skim = getSkims(journalFile).find((s) => s.signature === signature);
  if (!skim || skim.status !== "pending") return { ok: false, error: operatorResolveRefusal(claim, "pending", skim) };
  const { verdict, st, txLookup } = await chainVerdict(conn, skim, { forceTxLookup: true });
  const refusal = operatorResolveRefusal(claim, verdict, skim);
  if (refusal) return { ok: false, error: refusal, chainVerdict: verdict };
  recordVerdict({ skim, verdict, st, txLookup, journalFile, mirror, getBaseline, saveBaseline, at: new Date(now()).toISOString() });
  log("skim", `[SKIM] operator resolved ${maskAddress(signature)} as ${verdict} (chain agrees)`);
  return { ok: true, verdict, skim };
}

// ─── the one send function ────────────────────────────────────────
let _sendLock = false;

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
export async function sendSkim({ amountSol, proposalId = null, reserveSol, reason = "profit_skim", expectedFreeSol = null }, deps = {}) {
  const {
    conn = getConnection(),
    wallet = getWallet(),
    destination: destinationDep,
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
    deadlineMs = SKIM_PRE_BROADCAST_DEADLINE_MS,
    balanceTolerance = 0.01,
  } = deps;
  let released = false;
  const releaseOnce = () => { if (released) return; released = true; try { release(); } catch { /* never fatal */ } };
  const refused = (error) => { log("skim_warn", `[SKIM] send refused: ${error}`); return { status: "refused", amountSol, error }; };
  if (_sendLock) return refused("another skim is being sent");
  _sendLock = true;
  let intentWritten = null;
  let acquired = false;
  try {
    const destination = destinationDep ?? await withDeadline(verifySkimDestinationOnChain({ conn }), 10_000, "destination check");
    if (!destination?.ok) return refused(`destination refused: ${destination?.error || "unknown"}`);
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
        tx.add(SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: new PublicKey(destination.address), lamports }));
        const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
        tx.recentBlockhash = blockhash;
        tx.feePayer = wallet.publicKey;
        tx.sign(wallet);
        let sim;
        try { sim = await conn.simulateTransaction(new VersionedTransaction(tx.compileMessage()), { sigVerify: false, commitment: "confirmed" }); }
        catch (e) { const err = new Error(`simulation could not run: ${e.message}`); err.refuse = true; throw err; }
        if (sim?.value?.err) { const e = new Error(`simulation failed: ${JSON.stringify(sim.value.err)}`); e.refuse = true; throw e; }
        return { tx, signature: bs58.encode(tx.signature), lastValidBlockHeight, balanceLamports, feeLamports };
      })(), deadlineMs, "pre-broadcast checks");
    } catch (e) {
      return refused(e.deadline ? `${e.message} — nothing sent` : e.message);
    }
    const { tx, signature, lastValidBlockHeight, balanceLamports, feeLamports } = prepared;
    const amount = lamports / LAMPORTS_PER_SOL;

    if (dryRun) {
      log("skim", `[SKIM] DRY_RUN: would send ◎${amount.toFixed(4)} to ${destination.masked} (simulation ok) — nothing sent`);
      return { status: "dry_run", amountSol: amount };
    }

    // Durable intent BEFORE the send: the signature is known, so a crash after this
    // line leaves a pending record that blocks any further skim until it is resolved.
    const createdAt = new Date(now()).toISOString();
    try {
      appendSkimJournal({ event: "pending", signature, amount_sol: amount, at: createdAt, last_valid_block_height: lastValidBlockHeight, proposal_id: proposalId, destination_masked: destination.masked, reason }, journalFile, mirror);
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
        const why = st?.err ? `on-chain error ${JSON.stringify(st.err)}` : "blockhash expired without the transaction landing";
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
      return { status: "unknown", signature: intentWritten, amountSol, error: e.message };
    }
    log("skim_error", `[SKIM] send failed before broadcast: ${e.message}`);
    return { status: "refused", amountSol, error: e.message };
  } finally {
    if (acquired) releaseOnce();
    _sendLock = false;
  }
}

// ─── inputs for the decision ──────────────────────────────────────
/** Positions as the decision sees them (RPC path only; closed / unready rows flagged). */
export async function readSkimPositions() {
  const { getMyPositions } = await import("./dlmm.js");
  const res = await getMyPositions({ force: true, silent: true });
  if (!res || res.error || !Array.isArray(res.positions)) return { valuationComplete: false, source: res?.source ?? null, positions: [] };
  const solPrice = getSolPriceUsd();
  const positions = res.positions.filter((p) => p?.position).map((p) => {
    // total_value_usd carries SOL under solMode (the unit landmine — see CLAUDE.md).
    const raw = Number(p.total_value_usd);
    const valueSol = config.management?.solMode ? raw : (solPrice > 0 ? raw / solPrice : NaN);
    const tracked = getTrackedPosition(p.position);
    return { position: p.position, valueSol, costSol: Number(tracked?.amount_sol), closed: tracked?.closed === true, ready: p.pnl_management_ready !== false };
  });
  return { valuationComplete: true, source: res.source ?? null, positions };
}

/** The live skim config (thresholds from config.autoSkim, confirmation switch + ceilings from the env). */
export function currentSkimConfig() {
  return skimConfig(config.autoSkim || {}, { env: process.env, gasReserveSol: config.management?.gasReserve ?? 0 });
}

function untrackedSwapFigures(baseline) {
  const swaps = Array.isArray(baseline?.token_swaps) ? baseline.token_swaps : [];
  const known = new Set();
  try { for (const p of getTrackedPositions(false)) if (p?.base_mint) known.add(p.base_mint); } catch { /* */ }
  return { untrackedSwapSolTotal: untrackedSwapSol(swaps, known), tokenSwapCount: swaps.length };
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
    const pos = await readSkimPositions();
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

/** sendSkim with the live dependencies (journal → state flush before the broadcast). */
export function executeSkim({ amountSol, proposalId, reserveSol, reason, expectedFreeSol }, hooks = {}) {
  return sendSkim({ amountSol, proposalId, reserveSol, reason, expectedFreeSol }, {
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
  config.autoSkim ??= {};
  config.autoSkim[field] = value;
  let uc = {};
  try { if (fs.existsSync(userConfigPath)) uc = JSON.parse(fs.readFileSync(userConfigPath, "utf8")); } catch (e) {
    throw new Error(`user-config.json unreadable: ${e.message}`);
  }
  uc.autoSkim = { ...(uc.autoSkim && typeof uc.autoSkim === "object" ? uc.autoSkim : {}), [field]: value };
  const tmp = `${userConfigPath}.skim.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(uc, null, 2));
  fs.renameSync(tmp, userConfigPath);
  log("skim", `[SKIM] operator set autoSkim.${field} = ${JSON.stringify(value)}`);
}
