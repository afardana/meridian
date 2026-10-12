// net-cost.js — DISPLAY-ONLY cost estimates for open positions (2026-10-12, operator decision).
//
// A two-sided position opened or re-ranged from the Meteora UI is built by a "zap": a Jupiter
// swap of part of the SOL into the base token in the same slot as the deposit. The swap fills
// above the pool's active-bin price, and at the close the base-token remainder is swapped back
// below it. Neither cost is in the live PnL (Meteora values deposits at the pool price):
// audited two-sided closes read a median 1.5 pp of capital above the wallet result (PQC-SOL
// 2026-10-11: read +1.06 %, netted +0.01 %).
//
//   entry cost — MEASURED once per purchase: SOL spent − tokens bought × the pool's active-bin
//                price at the deposit (the price Meteora books the deposit at).
//   exit cost  — ESTIMATED: a read-only sell quote for the base side against the active-bin
//                price, plus the exit gas estimate; refreshed slowly.
//
// NOTHING here is a rule input. Every exit keeps reading the gross SOL-basis pnl_pct
// (test/net-cost.test.js asserts the evaluator, the hold limit, the TVL exit and the poller
// fast paths never reference these fields).

import bs58 from "bs58";
import { walletDeltas, isPositionOperation } from "./close-audit.js";

const WSOL_MINT = "So11111111111111111111111111111111111111112";
const DLMM_PROGRAM = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
// Same matching rule as the close audit (close-audit.js): a purchase is this position's own
// when the position deposits >= 90 % of the tokens within 60 s after it (the UI zap: same slot).
const BUY_MATCH_MIN_SHARE = 0.9;
const BUY_MATCH_WINDOW_SEC = 60;
const MIN_SWAP_SOL = 1e-4;
// Anchor event-CPI tag + the two DLMM events that carry the active bin of a deposit.
const EVENT_IX_TAG = [0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d];
const EVT_REBALANCING = [0, 109, 117, 179, 61, 91, 199, 200];   // lb_pair, position, owner, active_bin_id i32 …
const EVT_ADD_LIQUIDITY = [31, 94, 125, 90, 227, 52, 61, 186];  // lb_pair, from, position, amounts[2], active_bin_id i32
// A measured purchase this close to a recorded straddle is that straddle's stage-B buy.
const STRADDLE_DEDUPE_BEFORE_SEC = 600;
const ENTRY_COST_MAX_ATTEMPTS = 3;
const ENTRY_COST_LOG_MAX = 8;

const num = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const r6 = (v) => (v == null ? null : Math.round(v * 1e6) / 1e6);
const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);
const startsWith = (buf, off, bytes) => bytes.every((b, i) => buf[off + i] === b);

/** SOL per whole base token at a bin: (1 + binStep/1e4)^bin × 10^(decX − decY). Null when unknown. */
export function binPriceSolPerToken(bin, binStep, decX, decY = 9) {
  const b = num(bin), s = num(binStep), dx = num(decX), dy = num(decY);
  if (b == null || s == null || dx == null || dy == null || !(s > 0)) return null;
  const p = Math.pow(1 + s / 1e4, b) * Math.pow(10, dx - dy);
  return Number.isFinite(p) && p > 0 ? p : null;
}

/**
 * Active bins the DLMM program reported in one parsed transaction (getParsedTransaction):
 * the Rebalancing / AddLiquidity events it emits by self-CPI carry `active_bin_id`.
 * @returns {{ event:string, position:string|null, active_bin:number }[]} in instruction order
 */
export function decodeDlmmActiveBins(tx) {
  const out = [];
  for (const group of tx?.meta?.innerInstructions || []) {
    for (const ix of group?.instructions || []) {
      const pid = (ix?.programId ?? "")?.toString?.() ?? String(ix?.programId ?? "");
      if (pid !== DLMM_PROGRAM || typeof ix?.data !== "string") continue;
      let buf;
      try { buf = bs58.decode(ix.data); } catch { continue; }
      if (buf.length < 16 || !startsWith(buf, 0, EVENT_IX_TAG)) continue;
      const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      if (startsWith(buf, 8, EVT_REBALANCING) && buf.length >= 116) {
        out.push({ event: "Rebalancing", position: bs58.encode(buf.subarray(48, 80)), active_bin: view.getInt32(112, true) });
      } else if (startsWith(buf, 8, EVT_ADD_LIQUIDITY) && buf.length >= 132) {
        out.push({ event: "AddLiquidity", position: bs58.encode(buf.subarray(80, 112)), active_bin: view.getInt32(128, true) });
      }
    }
  }
  return out;
}

const txOrder = (a, b) => ((Number(a?.slot) || 0) - (Number(b?.slot) || 0)) || ((Number(a?.blockTime) || 0) - (Number(b?.blockTime) || 0));

/**
 * The base-token purchases this position deposited (UI zap: a wallet-side swap whose tokens
 * the position takes in within 60 s / the same slot). Pure; same pairing rule as the close
 * audit. `spent_sol` is the SOL-equivalent the purchase cost (native + wSOL, less any rent it
 * parked in the wallet's own token account of the mint — that rent comes back).
 * `active_bin` is the bin the DLMM program reported in the deposit transaction (null when the
 * transaction carries no event, e.g. a trimmed fixture — the caller supplies a hint).
 * `skipTimes` (epoch s): purchases up to 10 min before one of them are a straddle's own buy.
 */
export function findZapPurchases({ posTxs = [], walletTxs = [], wallet, baseMint, positionAddress = null, skipTimes = [] } = {}) {
  const deposits = [];
  for (const tx of [...posTxs].sort(txOrder)) {
    const d = walletDeltas(tx, wallet, baseMint);
    if (!d || !(d.dTok < 0)) continue;
    const bins = decodeDlmmActiveBins(tx).filter((e) => !positionAddress || !e.position || e.position === positionAddress);
    deposits.push({ t: Number(tx?.blockTime) || 0, slot: Number(tx?.slot) || 0, left: -d.dTok, active_bin: bins.length ? bins[bins.length - 1].active_bin : null });
  }
  // A bundle's other transactions in the same slot (the withdrawal leg) report the bin too.
  const slotBin = new Map();
  for (const tx of posTxs) {
    const bins = decodeDlmmActiveBins(tx).filter((e) => !positionAddress || !e.position || e.position === positionAddress);
    if (bins.length && Number(tx?.slot)) slotBin.set(Number(tx.slot), bins[bins.length - 1].active_bin);
  }
  const out = [];
  for (const tx of [...walletTxs].sort(txOrder)) {
    if (isPositionOperation(tx)) continue;
    const d = walletDeltas(tx, wallet, baseMint);
    if (!d || !(d.dTok > 0)) continue;
    const spent = -(d.dSolEq + (d.dMintAccountsSol ?? 0));
    if (!(spent >= MIN_SWAP_SOL)) continue;
    const t = Number(tx?.blockTime) || 0, slot = Number(tx?.slot) || 0;
    if (skipTimes.some((s) => Number.isFinite(s) && t <= s + 5 && s - t <= STRADDLE_DEDUPE_BEFORE_SEC)) continue;
    const usable = deposits.filter((dep) => dep.left > 0 && dep.t >= t && dep.t - t <= BUY_MATCH_WINDOW_SEC && (!slot || !dep.slot || dep.slot >= slot));
    const available = usable.reduce((s, dep) => s + dep.left, 0);
    if (!(available >= BUY_MATCH_MIN_SHARE * d.dTok)) continue; // not deposited here: not this position's entry
    let need = d.dTok, bin = null;
    for (const dep of usable) {
      const take = Math.min(dep.left, need);
      dep.left -= take; need -= take;
      if (bin == null) bin = dep.active_bin ?? slotBin.get(dep.slot) ?? null;
      if (need <= 0) break;
    }
    out.push({ sig: tx?.sig ?? tx?.transaction?.signatures?.[0] ?? null, t, slot, tokens: d.dTok, spent_sol: spent, active_bin: bin });
  }
  return out;
}

/**
 * Premium paid over the pool price on a set of purchases. Pure.
 * cost = Σ (SOL spent − tokens × SOL-per-token at the deposit's active bin). A purchase with
 * no bin (no event and no hint) cannot be measured and is reported in `unmeasured`.
 * The premium is SIGNED: when the purchase itself moved this pool's bin up before the deposit
 * landed, Meteora books the tokens above what was paid and the live PnL is UNDER-stated
 * (darwin-SOL EKJDLcWh 2026-10-06: −◎0.0154 measured, audit gap −◎0.0104).
 */
export function measureEntryCost({ purchases = [], binStep, decX, decY = 9, hintBin = null } = {}) {
  let cost = 0, events = 0, unmeasured = 0;
  const detail = [];
  for (const p of purchases) {
    const bin = p.active_bin ?? num(hintBin);
    const px = binPriceSolPerToken(bin, binStep, decX, decY);
    if (px == null) { unmeasured++; continue; }
    const fair = p.tokens * px;
    const c = p.spent_sol - fair;
    cost += c; events++;
    detail.push({ t: p.t, slot: p.slot, sig: p.sig ? String(p.sig).slice(0, 12) : null, tokens: p.tokens, spent_sol: r6(p.spent_sol), ref_bin: bin, ref_from: p.active_bin != null ? "event" : "hint", premium_sol: r6(c), premium_pct: fair > 0 ? r2((p.spent_sol / fair - 1) * 100) : null });
  }
  return { cost_sol: cost, events, unmeasured, detail };
}

/** Stage B of the bot's own straddle: SOL paid − tokens bought × the active-bin price (signed). Pure. */
export function straddleEntryCost({ swapSol, boughtTokens, solPerBase } = {}) {
  const s = num(swapSol), t = num(boughtTokens), p = num(solPerBase);
  if (s == null || t == null || p == null || !(s > 0) || !(t > 0) || !(p > 0)) return null;
  return s - t * p;
}

/**
 * Fold one measurement into the position's stored entry cost. Pure: returns the patch for
 * state.recordNetCostTracking. `kind`: "measured" (UI zap read from chain) | "straddle".
 * Source: "straddle" while every counted purchase was the bot's own straddle, else "measured";
 * "none" when a scan found no purchase at all; an earlier measurement is never lost.
 */
export function mergeEntryCost(pos, { kind, cost_sol = 0, events = 0, at = new Date().toISOString(), detail = null } = {}) {
  const prevCost = num(pos?.entry_cost_sol) ?? 0;
  const prevEvents = num(pos?.entry_cost_events) ?? 0;
  const prevSource = pos?.entry_cost_source ?? null;
  const total = prevEvents + events;
  let source;
  if (total === 0) source = "none";
  else if (kind === "straddle") source = prevEvents > 0 && prevSource === "measured" ? "measured" : "straddle";
  else source = events > 0 ? "measured" : (prevSource === "straddle" ? "straddle" : "measured");
  const patch = {
    entry_cost_sol: r6(prevCost + (events > 0 ? (num(cost_sol) ?? 0) : 0)),
    entry_cost_events: total,
    entry_cost_source: source,
    entry_cost_at: at,
  };
  if (events > 0) {
    const entry = { at, kind, sol: r6(num(cost_sol) ?? 0), events, ...(detail ? { detail } : {}) };
    patch.entry_cost_log = [...(Array.isArray(pos?.entry_cost_log) ? pos.entry_cost_log : []), entry].slice(-ENTRY_COST_LOG_MAX);
  }
  return patch;
}

/** Epoch seconds of the straddles already counted (their stage-B buys must not be re-read from chain). */
export function straddleTimes(pos) {
  return (Array.isArray(pos?.entry_cost_log) ? pos.entry_cost_log : [])
    .filter((e) => e?.kind === "straddle")
    .map((e) => new Date(e.at).getTime() / 1000)
    .filter(Number.isFinite);
}

/**
 * Does this open position need its entry cost read from chain? Pure.
 *   "none"   — a bot ladder that was never re-ranged: single-sided SOL, no purchase, no RPC
 *   "scan"   — adopted and not measured yet, re-ranged since the last scan, or a scan left more
 *   "giveup" — attempts exhausted: mark unavailable and stop
 *   null     — nothing to do
 */
export function entryCostWork(pos, { nowMs = Date.now(), minAgeSec = 20 } = {}) {
  if (!pos || pos.closed) return null;
  const rebalances = num(pos.rebalance_count) ?? 0;
  const seen = num(pos.entry_cost_rebalances_seen) ?? 0;
  const pendingRerange = rebalances > seen;
  const neverMeasured = pos.entry_cost_source == null;
  if (!neverMeasured && !pendingRerange && pos.entry_cost_more !== true) return null;
  if (neverMeasured && !pos.adopted && rebalances === 0) return "none";
  if ((num(pos.entry_cost_attempts) ?? 0) >= ENTRY_COST_MAX_ATTEMPTS) return "giveup";
  const ref = new Date(pos.last_rebalanced_at && pendingRerange ? pos.last_rebalanced_at : (pos.adopted_at || pos.deployed_at || 0)).getTime();
  if (Number.isFinite(ref) && nowMs - ref < minAgeSec * 1000) return null; // let the RPC index it
  return "scan";
}

/**
 * Was the position built with a base-token leg ("two-sided")? Pure. True when
 *   (a) a base-token purchase was measured or made for it (entry_cost_events > 0, or the bot
 *       straddled it), or
 *   (b) its range extended ABOVE the active bin when the bot first saw it (deploy / adoption)
 *       or at its latest re-range — bins above the price can only be funded with base token.
 * A single-sided SOL ladder (upper bin at or below the price at entry) is false, even after
 * the price has fallen into it and converted its SOL to base.
 */
export function isTwoSided(pos) {
  if (!pos) return false;
  if ((num(pos.entry_cost_events) ?? 0) > 0) return true;
  if ((num(pos.straddle_count) ?? 0) > 0 || pos.lane === "straddle") return true;
  const evs = Array.isArray(pos.rebalance_events) ? pos.rebalance_events : [];
  if (evs.length) {
    const above = num(evs[evs.length - 1]?.new_bins_above);
    if (above != null) return above > 0;
  }
  if ((num(pos.rebalance_count) ?? 0) > 0) return false; // re-ranged, shape unknown
  const entryBin = num(pos.active_bin_at_deploy), upper = num(pos.bin_range?.max);
  return entryBin != null && upper != null && upper > entryBin;
}

/** One-way sell cost in % of the base side's pool value: (1 − SOL quoted ÷ tokens × pool price). Pure. */
export function exitImpactFromQuote({ tokens, solPerToken, solOut } = {}) {
  const t = num(tokens), p = num(solPerToken), o = num(solOut);
  if (t == null || p == null || o == null || !(t > 0) || !(p > 0) || !(o >= 0)) return null;
  return Math.min(100, Math.max(0, (1 - o / (t * p)) * 100));
}

/** The base side of an open-position row: tokens (liquidity + unclaimed fees) and their pool value in SOL. Pure. */
export function baseSideOf(row) {
  if (!row || (row.token_y_mint && row.token_y_mint !== WSOL_MINT)) return null;
  const px = num(row.price_active);
  const tokens = (num(row.liq_x_amount) ?? 0) + (num(row.fee_x_amount) ?? 0);
  if (px == null || !(px > 0)) return null;
  return { tokens, sol_per_token: px, value_sol: tokens * px };
}

/**
 * Is an exit swap of this wallet still settling? Only a RECENT deferral counts: the deferred
 * map also keeps dust the sweeper has held for weeks (impact above the cap), and treating those
 * as "in flight" stopped the maintenance for good (2026-10-12).
 */
export function hasRecentDeferredExitSwap(deferred = {}, nowMs = Date.now(), windowMs = 10 * 60_000) {
  return Object.values(deferred || {}).some((d) => {
    const at = Date.parse(d?.at);
    return Number.isFinite(at) && nowMs - at < windowMs;
  });
}

/**
 * Which open position gets this cycle's exit quote? Pure. Stalest attempt first (never tried
 * first), so the positions take turns; nothing is due until `minIntervalSec` after its last
 * attempt. Held positions are included.
 * @returns {string[]} position addresses that are due, in the order to try them
 */
export function exitQuoteQueue(positions = [], trackedOf = () => null, { nowMs = Date.now(), minIntervalSec = 900 } = {}) {
  const due = [];
  for (const p of positions) {
    const t = trackedOf(p.position);
    if (!t || t.closed) continue;
    const last = t.exit_cost_est_tried_at ? new Date(t.exit_cost_est_tried_at).getTime() : 0;
    if (last && nowMs - last < minIntervalSec * 1000) continue;
    due.push({ position: p.position, last: Number.isFinite(last) ? last : 0 });
  }
  return due.sort((a, b) => a.last - b.last).map((d) => d.position);
}

/**
 * The exposed fields (scan row → dashboard-report doc → tick). Pure; display only.
 * Percentages are of the capital (`amount_sol`), the same basis as the gross SOL `pnl_pct`.
 * The exit estimate applies the last quoted sell cost (%) to the base side the position holds
 * NOW, plus the gas estimate taken with that quote.
 */
export function netCostCardFields(pos, row = {}, mgmt = {}) {
  const twoSided = isTwoSided(pos);
  const off = {
    two_sided: twoSided,
    entry_cost_sol: null, entry_cost_pct: null, entry_cost_source: pos?.entry_cost_source ?? null,
    exit_cost_est_sol: null, exit_cost_est_pct: null, exit_cost_est_at: null,
    net_cost_est_pct: null, net_cost_partial: false, pnl_net_est_pct: null,
  };
  if (!pos || mgmt?.netCostEstimateEnabled === false) return off;
  const capital = num(pos.amount_sol);
  const pct = (sol) => (sol != null && capital > 0 ? (sol / capital) * 100 : null);

  const source = pos.entry_cost_source ?? null;
  const entrySol = source === "measured" || source === "straddle" || source === "none"
    ? (num(pos.entry_cost_sol) ?? 0)
    : ((num(pos.entry_cost_events) ?? 0) > 0 ? num(pos.entry_cost_sol) : null); // "unavailable" after an earlier measurement keeps it
  const entryPct = pct(entrySol);

  let exitSol = null;
  const impact = num(pos.exit_cost_est_impact_pct);
  if (impact != null && pos.exit_cost_est_at) {
    const base = baseSideOf(row);
    if (base) exitSol = base.value_sol * (impact / 100) + (num(pos.exit_cost_est_gas_sol) ?? 0);
  }
  const exitPct = pct(exitSol);

  const known = [entryPct, exitPct].filter((v) => v != null);
  const netCost = known.length ? known.reduce((s, v) => s + v, 0) : null;
  const gross = num(row.pnl_pct);
  return {
    two_sided: twoSided,
    entry_cost_sol: r6(entrySol), entry_cost_pct: r2(entryPct), entry_cost_source: source,
    exit_cost_est_sol: r6(exitSol), exit_cost_est_pct: r2(exitPct), exit_cost_est_at: exitSol != null ? pos.exit_cost_est_at : null,
    net_cost_est_pct: r2(netCost), net_cost_partial: known.length === 1,
    pnl_net_est_pct: netCost != null && gross != null ? r2(gross - netCost) : null,
  };
}

const NET_COST_ROW_FIELDS = ["two_sided", "entry_cost_sol", "entry_cost_pct", "entry_cost_source", "exit_cost_est_sol", "exit_cost_est_pct", "exit_cost_est_at", "net_cost_est_pct", "net_cost_partial", "pnl_net_est_pct"];

/** Pass-through of the row fields into the dashboard-report doc. */
export function reportNetCostFields(p) {
  const out = {};
  for (const k of NET_COST_ROW_FIELDS) out[k] = p?.[k] ?? (k === "two_sided" || k === "net_cost_partial" ? false : null);
  return out;
}

/** The tick carries the two cost percentages only: the client recomputes net from the live gross pnl_pct. */
export function tickNetCostFields(p) {
  return { two_sided: p?.two_sided === true, entry_cost_pct: p?.entry_cost_pct ?? null, exit_cost_est_pct: p?.exit_cost_est_pct ?? null };
}

/** Telegram: " (net ≈ +1.2%)" after the gross PnL — two-sided positions with an estimate only. */
export function netPnlSuffix(p) {
  const v = num(p?.pnl_net_est_pct);
  if (p?.two_sided !== true || v == null) return "";
  return ` (net ≈ ${v >= 0 ? "+" : ""}${v.toFixed(1)}%)`;
}

/**
 * Read the transactions an entry-cost measurement needs. Bounded:
 *   1 signature list of the position account, ≤ maxPosTx of its transactions (after
 *   `afterSlot`), and — only when one of them deposits the base token — 1 signature list of
 *   the wallet's token account of the mint and ≤ maxWalletTx of the wallet's transactions in
 *   the 60 s before a deposit. A single-sided adoption costs 2–3 reads, a UI zap ~6.
 * `rpc(fn)` runs fn(connection). Returns null when the position has no readable signature yet.
 */
export async function fetchEntryCostTxs({ rpc, PublicKey, wallet, positionAddress, baseMint, afterSlot = null, maxPosTx = 20, maxWalletTx = 6 }) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const all = (await rpc((c) => c.getSignaturesForAddress(new PublicKey(positionAddress), { limit: 100 }))).reverse();
  const truncated = all.length >= 100 && afterSlot == null;
  const fresh = all.filter((s) => !s.err && (afterSlot == null || s.slot > afterSlot));
  if (!all.length) return null;
  const take = fresh.slice(0, maxPosTx);
  const get = async (sig) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const tx = await rpc((c) => c.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0 }));
        if (tx) return tx;
      } catch (e) {
        if (/version/i.test(String(e?.message))) return undefined;
      }
      await sleep(400 * (attempt + 1));
    }
    return undefined;
  };
  let unreadable = 0, reads = 1;
  const posTxs = [];
  for (const s of take) {
    const tx = await get(s.signature); reads++;
    if (!tx) { unreadable++; continue; }
    posTxs.push({ ...tx, sig: s.signature, blockTime: tx.blockTime ?? s.blockTime, slot: tx.slot ?? s.slot });
    await sleep(100);
  }
  // Token deposits by the wallet, and the wallet's token account of the mint they came from.
  const depositTimes = [];
  let tokenAccount = null;
  for (const tx of posTxs) {
    const d = walletDeltas(tx, wallet, baseMint);
    if (!d || !(d.dTok < 0)) continue;
    depositTimes.push(Number(tx.blockTime) || 0);
    if (!tokenAccount) {
      const keys = (tx.transaction?.message?.accountKeys || []).map((k) => (k?.pubkey ?? k)?.toString?.() ?? String(k));
      const bal = [...(tx.meta?.preTokenBalances || []), ...(tx.meta?.postTokenBalances || [])].find((b) => b.owner === wallet && b.mint === baseMint && Number.isInteger(b.accountIndex));
      if (bal && keys[bal.accountIndex]) tokenAccount = keys[bal.accountIndex];
    }
  }
  const walletTxs = [];
  if (depositTimes.length && tokenAccount) {
    const inPos = new Set(all.map((s) => s.signature));
    const earliest = Math.min(...depositTimes) - BUY_MATCH_WINDOW_SEC;
    const cands = [];
    let before;
    for (let page = 0; page < 3; page++) {
      const batch = await rpc((c) => c.getSignaturesForAddress(new PublicKey(tokenAccount), { limit: 1000, before })); reads++;
      for (const s of batch) {
        if (s.err || inPos.has(s.signature)) continue;
        if (depositTimes.some((t) => s.blockTime <= t && t - s.blockTime <= BUY_MATCH_WINDOW_SEC)) cands.push(s);
      }
      if (batch.length < 1000 || batch[batch.length - 1].blockTime < earliest) break;
      before = batch[batch.length - 1].signature;
    }
    for (const s of cands.slice(0, maxWalletTx)) {
      const tx = await get(s.signature); reads++;
      if (tx) walletTxs.push({ ...tx, sig: s.signature, blockTime: tx.blockTime ?? s.blockTime, slot: tx.slot ?? s.slot });
      else unreadable++;
      await sleep(100);
    }
  }
  return {
    posTxs, walletTxs, unreadable, truncated, reads,
    last_slot: take.length ? take[take.length - 1].slot : afterSlot,
    more: fresh.length > take.length,
    token_deposits: depositTimes.length,
  };
}

export { ENTRY_COST_MAX_ATTEMPTS };
