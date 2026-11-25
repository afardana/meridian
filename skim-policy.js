/**
 * Profit skimmer — pure policy (2026-11-25).
 *
 * The skimmer is the only code path that sends funds to an external address. Everything
 * that DECIDES lives here and is pure (no RPC, no state, no clock unless passed in):
 *   - skimConfig()               normalized thresholds, hard floors / ceilings (code + env)
 *                                and the env-only confirmation switch
 *   - validateSkimSetting()      the operator-only setter's validation (/skim set)
 *   - checkSkimDestination()     format checks for the env-only destination
 *   - checkSkimDestinationAccount() on-chain account shape (plain system wallet)
 *   - reduceSkimJournal()        the append-only skim journal → one record per signature
 *   - skimIntegrity()            journal vs Postgres mirror vs baseline — fails CLOSED
 *   - skimLedger()               net operator capital, skims, 24 h use, cooldown
 *   - computeSkimDecision()      amount or refusal with a reason
 *   - createSkimProposalStore()  proposals bound to amount + destination + expiry + nonce
 *   - skimCommandRefusal()       Telegram message shape checks for the confirm step
 *   - resolveSkimStatus()        landed / failed / pending from the chain's answers
 *   - operatorResolveRefusal()   /skim resolve may only write what the chain shows
 *   - bookSkimWithdrawal()       idempotent booking into the baseline withdrawals
 *
 * Profit = conservative equity − adjusted capital, where
 *   net operator capital = baseline deposits − baseline withdrawals that are NOT skims
 *   adjusted capital     = net operator capital + max(0, Σ SOL from swaps of untracked
 *                          tokens) — SOL that came from selling tokens that were sent in
 *                          (airdrops, transfers) is not a deposit, so it is netted out
 *   conservative equity  = free SOL + Σ min(value, cost) over open positions
 * so an operator deposit is never profit, a payment the operator makes from the wallet
 * lowers capital and equity alike, an unrealised gain is never skimmed, an unrealised
 * loss is counted, and a skim (booked as a withdrawal) lowers the profit left by its own
 * amount. The skim never takes equity below max(adjusted capital, targetWorkingCapitalSol).
 */
import { PublicKey } from "@solana/web3.js";

export const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
export const SKIM_PROPOSAL_TTL_MS = 10 * 60 * 1000;
export const SKIM_HARD_MIN_RESERVE_SOL = 0.05;
export const SKIM_HARD_MIN_INTERVAL_MIN = 10;
export const SKIM_HARD_MIN_AMOUNT_SOL = 0.01;
/** Code ceilings, in every mode; .env AUTO_SKIM_MAX_PER_SKIM_SOL / AUTO_SKIM_MAX_DAILY_SOL can only lower them. */
export const SKIM_HARD_MAX_PER_SKIM_SOL = 5;
export const SKIM_HARD_MAX_DAILY_SOL = 10;
/** Free SOL read before and after the position read may differ by at most this much. */
export const SKIM_BALANCE_DRIFT_TOLERANCE_SOL = 0.01;
/** baseline.token_swaps is capped at this many rows (tools/wallet.js TOKEN_SWAPS_CAP). */
export const TOKEN_SWAPS_CAP = 300;
/** Reasons the pre-2026-11-25 transferSol() wrote on its baseline withdrawal entries. */
export const LEGACY_SKIM_REASONS = new Set(["profit_skim", "manual_telegram_skim", "telegram_button_skim", "auto_skim_pionex"]);
const LAMPORTS = 1e9;

/** Program ids, mints and sysvars a skim must never be sent to. */
export const SKIM_DESTINATION_DENYLIST = new Set([
  SYSTEM_PROGRAM_ID,
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", // SPL Token
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", // Token-2022
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", // Associated Token Account program
  "So11111111111111111111111111111111111111112", // wSOL mint
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC mint
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo", // Meteora DLMM
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", // Jupiter v6
  "ComputeBudget111111111111111111111111111111",
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
  "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo",
  "SysvarRent111111111111111111111111111111111",
  "SysvarC1ock11111111111111111111111111111111",
  "Vote111111111111111111111111111111111111111",
  "Stake11111111111111111111111111111111111111",
]);

const num = (v) => (v == null || v === "" ? NaN : Number(v));
const fin = (v, dflt) => (Number.isFinite(num(v)) ? num(v) : dflt);
const r6 = (v) => Math.round(v * 1e6) / 1e6;

export function maskAddress(address) {
  const s = String(address ?? "");
  return s.length > 8 ? `${s.slice(0, 4)}…${s.slice(-4)}` : "?";
}

/** A positive .env ceiling, else the code ceiling (an env value can only LOWER it). */
function envCeiling(raw, hard) {
  const v = num(raw);
  return Number.isFinite(v) && v >= 0 ? Math.min(v, hard) : hard;
}

/**
 * Thresholds from config.autoSkim (set only by the operator's /skim commands) with hard
 * floors and ceilings, plus the confirmation switch, read from the ENVIRONMENT only: the
 * confirmation is required unless AUTO_SKIM_REQUIRE_CONFIRMATION is exactly the string
 * "false" (no trimming, no case folding).
 */
export function skimConfig(raw = {}, { env = {}, gasReserveSol = 0 } = {}) {
  const perSkimCeiling = envCeiling(env.AUTO_SKIM_MAX_PER_SKIM_SOL, SKIM_HARD_MAX_PER_SKIM_SOL);
  const dailyCeiling = envCeiling(env.AUTO_SKIM_MAX_DAILY_SOL, SKIM_HARD_MAX_DAILY_SOL);
  const minTransferAmountSol = Math.max(SKIM_HARD_MIN_AMOUNT_SOL, fin(raw.minTransferAmountSol, 0.5));
  return {
    enabled: raw.enabled === true,
    targetWorkingCapitalSol: Math.max(0, fin(raw.targetWorkingCapitalSol, 6.2529)),
    minTransferAmountSol,
    maxPerSkimSol: Math.min(perSkimCeiling, Math.max(0, fin(raw.maxPerSkimSol, 1.0))),
    minWalletReserveSol: Math.max(SKIM_HARD_MIN_RESERVE_SOL, fin(raw.minWalletReserveSol, 0.1), fin(gasReserveSol, 0)),
    transferIntervalMin: Math.max(SKIM_HARD_MIN_INTERVAL_MIN, fin(raw.transferIntervalMin, 60)),
    maxDailyTransferSol: Math.min(dailyCeiling, Math.max(0, fin(raw.maxDailyTransferSol, 2.0))),
    requireConfirmation: env.AUTO_SKIM_REQUIRE_CONFIRMATION !== "false",
    perSkimCeilingSol: perSkimCeiling,
    dailyCeilingSol: dailyCeiling,
  };
}

/** Operator setting names (/skim set <name> <value>) → config.autoSkim field. */
export const SKIM_SETTINGS = {
  enabled: "enabled",
  target: "targetWorkingCapitalSol",
  min: "minTransferAmountSol",
  perskim: "maxPerSkimSol",
  daily: "maxDailyTransferSol",
  reserve: "minWalletReserveSol",
  interval: "transferIntervalMin",
};

/**
 * Validate one operator setting against the current autoSkim block and the ceilings.
 * Returns { ok, field, value } or { ok:false, error }.
 */
export function validateSkimSetting(name, rawValue, current = {}, { env = {} } = {}) {
  const key = String(name ?? "").trim().toLowerCase();
  const field = SKIM_SETTINGS[key];
  if (!field) return { ok: false, error: `unknown setting "${name}" (use ${Object.keys(SKIM_SETTINGS).join(", ")})` };
  if (field === "enabled") {
    if (rawValue === true || rawValue === "on" || rawValue === "true") return { ok: true, field, value: true };
    if (rawValue === false || rawValue === "off" || rawValue === "false") return { ok: true, field, value: false };
    return { ok: false, error: "enabled must be on or off" };
  }
  const v = num(rawValue);
  if (!Number.isFinite(v)) return { ok: false, error: `${key} must be a number` };
  const cfg = skimConfig(current, { env });
  const after = { ...cfg, [field]: v };
  if (field === "targetWorkingCapitalSol" && v < 0) return { ok: false, error: "target must be ≥ 0" };
  if (field === "maxPerSkimSol" && !(v > 0 && v <= cfg.perSkimCeilingSol)) return { ok: false, error: `per-skim cap must be > 0 and ≤ ◎${cfg.perSkimCeilingSol}` };
  if (field === "maxDailyTransferSol" && !(v > 0 && v <= cfg.dailyCeilingSol)) return { ok: false, error: `daily cap must be > 0 and ≤ ◎${cfg.dailyCeilingSol}` };
  if (field === "minTransferAmountSol" && !(v >= SKIM_HARD_MIN_AMOUNT_SOL)) return { ok: false, error: `minimum must be ≥ ◎${SKIM_HARD_MIN_AMOUNT_SOL}` };
  if (field === "minWalletReserveSol" && !(v >= SKIM_HARD_MIN_RESERVE_SOL && v <= 5)) return { ok: false, error: `reserve must be ◎${SKIM_HARD_MIN_RESERVE_SOL}–◎5` };
  if (field === "transferIntervalMin" && !(v >= SKIM_HARD_MIN_INTERVAL_MIN && v <= 10080)) return { ok: false, error: `interval must be ${SKIM_HARD_MIN_INTERVAL_MIN}–10080 min` };
  if (after.maxDailyTransferSol < after.maxPerSkimSol) return { ok: false, error: `daily cap ◎${after.maxDailyTransferSol} must be ≥ per-skim cap ◎${after.maxPerSkimSol}` };
  if (after.minTransferAmountSol > after.maxPerSkimSol) return { ok: false, error: `minimum ◎${after.minTransferAmountSol} must be ≤ per-skim cap ◎${after.maxPerSkimSol}` };
  return { ok: true, field, value: v };
}

/** Format checks on the destination (the env value). No RPC. */
export function checkSkimDestination(address, { walletAddress = null } = {}) {
  if (address == null || String(address).trim() === "") {
    return { ok: false, address: null, masked: null, error: "PIONEX_DEPOSIT_ADDRESS is not set in .env" };
  }
  const raw = String(address);
  const clean = raw.trim();
  if (/\s/.test(clean)) return { ok: false, address: null, masked: null, error: "destination contains whitespace" };
  let pk;
  try { pk = new PublicKey(clean); } catch { return { ok: false, address: null, masked: null, error: "destination is not a base58 Solana address" }; }
  const canonical = pk.toBase58();
  const masked = maskAddress(canonical);
  if (canonical !== clean) return { ok: false, address: null, masked, error: "destination is not in canonical base58 form" };
  if (!PublicKey.isOnCurve(pk.toBuffer())) return { ok: false, address: null, masked, error: "destination is off-curve (a program-derived address, not a wallet)" };
  if (SKIM_DESTINATION_DENYLIST.has(canonical)) return { ok: false, address: null, masked, error: "destination is a program, sysvar or token mint" };
  if (walletAddress && canonical === String(walletAddress)) return { ok: false, address: null, masked, error: "destination is the bot wallet itself" };
  return { ok: true, address: canonical, masked, error: null };
}

/**
 * The destination account as the chain shows it: a plain system-owned wallet, or not
 * created yet (a system transfer creates it). Anything owned by another program — a
 * token account, a program account — or executable is refused.
 * `info` = getAccountInfo(...) result: null | { owner: PublicKey|string, executable }.
 */
export function checkSkimDestinationAccount(info) {
  if (info === undefined) return { ok: false, error: "destination account could not be read" };
  if (info === null) return { ok: true, error: null, exists: false };
  if (info.executable) return { ok: false, error: "destination is an executable program account" };
  const owner = info.owner?.toBase58 ? info.owner.toBase58() : String(info.owner ?? "");
  if (owner !== SYSTEM_PROGRAM_ID) return { ok: false, error: `destination is owned by ${maskAddress(owner)}, not the System Program (a token or program account)` };
  return { ok: true, error: null, exists: true };
}

/**
 * The skim journal is append-only (one line per event). Reduce it to the latest state
 * per signature: { signature, amount_sol, status, created_at, last_valid_block_height,
 * proposal_id, destination_masked, resolved_at }.
 */
export function reduceSkimJournal(events = []) {
  const bySig = new Map();
  for (const e of events) {
    if (!e || typeof e.signature !== "string" || !e.signature) continue;
    const prev = bySig.get(e.signature) || {};
    if (e.event === "pending") {
      bySig.set(e.signature, {
        ...prev,
        signature: e.signature,
        amount_sol: Number(e.amount_sol),
        status: prev.status && prev.status !== "pending" ? prev.status : "pending",
        created_at: e.at,
        last_valid_block_height: Number(e.last_valid_block_height) || null,
        proposal_id: e.proposal_id ?? null,
        destination_masked: e.destination_masked ?? null,
      });
    } else if (e.event === "landed" || e.event === "failed") {
      // landed is final; a later "failed" never overrides it
      if (prev.status === "landed") continue;
      bySig.set(e.signature, { ...prev, signature: e.signature, status: e.event, resolved_at: e.at, ...(prev.amount_sol == null ? { amount_sol: Number(e.amount_sol) } : {}) });
    }
  }
  return [...bySig.values()];
}

/** A baseline withdrawal that is a skim: by journal signature, by the skim flag, or by a legacy reason. */
export function isSkimWithdrawal(w, journalSigs = new Set()) {
  if (!w) return false;
  return journalSigs.has(w.signature) || w.skim === true || LEGACY_SKIM_REASONS.has(w.reason);
}

/**
 * Journal ↔ Postgres mirror ↔ baseline consistency. Fails CLOSED:
 *   - an unreadable journal line (a torn write could hide a pending entry)
 *   - the journal file is missing but the mirror lists skims (lost / new data dir)
 *   - the mirror lists a signature the journal does not (part of the journal lost)
 *   - the baseline holds a skim-flagged withdrawal the journal does not know
 * A LANDED journal entry the baseline lacks is not a refusal: it is returned in
 * `toBook` and booked by the caller.
 * journal = { exists, corrupt, skims }, mirror = { entries: { [sig]: {...} } } | null.
 */
export function skimIntegrity({ journal = {}, mirror = null, baseline = {} } = {}) {
  const skims = journal.skims || [];
  const sigs = new Set(skims.map((s) => s.signature));
  const mirrorSigs = Object.keys(mirror?.entries || {});
  const withdrawals = Array.isArray(baseline?.withdrawals) ? baseline.withdrawals : [];
  const fail = (reason) => ({ ok: false, reason, toBook: [] });
  if (journal.corrupt > 0) return fail(`the skim journal has ${journal.corrupt} unreadable line(s) — repair skim-journal.jsonl before any skim`);
  if (journal.exists === false && mirrorSigs.length > 0) return fail(`skim-journal.jsonl is missing but the Postgres mirror lists ${mirrorSigs.length} skim(s) — restore the journal; it is not rebuilt automatically`);
  const lostFromJournal = mirrorSigs.filter((s) => !sigs.has(s));
  if (lostFromJournal.length) return fail(`the Postgres mirror lists ${lostFromJournal.length} skim(s) the journal does not (${maskAddress(lostFromJournal[0])}) — restore the journal`);
  const unknownBooked = withdrawals.filter((w) => (w?.skim === true || LEGACY_SKIM_REASONS.has(w?.reason)) && !sigs.has(w.signature));
  if (unknownBooked.length) return fail(`the baseline holds ${unknownBooked.length} skim withdrawal(s) the journal does not know (${maskAddress(unknownBooked[0].signature)}) — restore the journal`);
  const booked = new Set(withdrawals.map((w) => w?.signature));
  const toBook = skims.filter((s) => s.status === "landed" && !booked.has(s.signature));
  return { ok: true, reason: null, toBook };
}

/**
 * SOL from swaps of tokens that are no position's base token (baseline.token_swaps,
 * filtered again by the caller's known mints). Positive = tokens that came in from
 * outside were sold — not a deposit, so it is netted out of profit.
 */
export function untrackedSwapSol(swaps = [], knownMints = new Set()) {
  let sol = 0;
  for (const s of Array.isArray(swaps) ? swaps : []) {
    if (!s?.mint || knownMints.has(s.mint)) continue;
    const v = Number(s.sol);
    if (Number.isFinite(v)) sol += v;
  }
  return r6(sol);
}

/**
 * Capital and skim figures from the baseline (deposits / withdrawals booked by the
 * deposit scan) and the reduced skim journal. A withdrawal is a skim when its signature
 * is in the journal (whatever the journal status), or it carries the skim flag / a
 * legacy skim reason — never an operator withdrawal.
 */
export function skimLedger(baseline = {}, skims = [], now = Date.now(), { untrackedSwapSolTotal = 0 } = {}) {
  const journalSigs = new Set(skims.map((s) => s.signature));
  const withdrawals = Array.isArray(baseline.withdrawals) ? baseline.withdrawals : [];
  const totalDeposited = fin(baseline.total_deposited, NaN);
  const totalWithdrawn = fin(baseline.total_withdrawn, 0);
  let skimWithdrawn = 0;
  for (const w of withdrawals) if (isSkimWithdrawal(w, journalSigs)) skimWithdrawn += Number(w.amount) || 0;
  const operatorWithdrawn = Math.max(0, totalWithdrawn - skimWithdrawn);
  const netCapital = totalDeposited - operatorWithdrawn;
  const swapInflow = Math.max(0, fin(untrackedSwapSolTotal, 0));
  const adjustedCapital = netCapital + swapInflow;

  const dayAgo = now - 24 * 60 * 60 * 1000;
  const bookedSigs = new Set(withdrawals.map((w) => w?.signature));
  let used24h = 0;
  for (const w of withdrawals) {
    const t = new Date(w?.timestamp || 0).getTime();
    if (Number.isFinite(t) && t > dayAgo) used24h += Number(w.amount) || 0;
  }
  const live = skims.filter((s) => s.status !== "failed");
  for (const s of live) {
    const t = new Date(s.created_at || 0).getTime();
    if (!bookedSigs.has(s.signature) && Number.isFinite(t) && t > dayAgo) used24h += Number(s.amount_sol) || 0;
  }
  const flaggedTimes = withdrawals.filter((w) => isSkimWithdrawal(w, journalSigs)).map((w) => new Date(w.timestamp || 0).getTime() || 0);
  const lastSkimAt = Math.max(0, ...live.map((s) => new Date(s.created_at || 0).getTime() || 0), ...flaggedTimes) || null;
  return {
    totalDeposited: r6(totalDeposited),
    operatorWithdrawn: r6(operatorWithdrawn),
    skimWithdrawn: r6(skimWithdrawn),
    skimmedTotal: r6(live.reduce((s, x) => s + (Number(x.amount_sol) || 0), 0)),
    netCapital: r6(netCapital),
    untrackedSwapInflowSol: r6(swapInflow),
    adjustedCapital: r6(adjustedCapital),
    used24h: r6(used24h),
    lastSkimAt,
    pending: skims.filter((s) => s.status === "pending"),
  };
}

/**
 * The decision. Returns { ok, amountSol, reason, figures }. `reason` is null when ok.
 *   cfg          skimConfig() output
 *   destination  { ok, masked, error } (format + on-chain check combined)
 *   baseline     the baseline state object (read only)
 *   skims        reduceSkimJournal() output
 *   integrity    skimIntegrity() output (null = not checked → refused)
 *   baselineFresh  true when a primary-RPC deposit scan at/after the balance slot just
 *                  completed; false refuses; null = not required (status display / cron pre-check)
 *   wallet       { freeSol, freeSolBefore, freeSolAfter, valuationComplete, source,
 *                  positions: [{ valueSol, costSol, closed, ready }] }
 *   untrackedSwapSolTotal, tokenSwapCount   from baseline.token_swaps
 *   inFlight     list of reasons a send must wait (cycles, closes, straddle flows)
 */
export function computeSkimDecision({ cfg, destination, baseline, skims = [], integrity = null, baselineFresh = null, wallet = {}, inFlight = [], untrackedSwapSolTotal = 0, tokenSwapCount = 0, tokenSwapsEvictedSol = 0, now = Date.now() }) {
  const ledger = skimLedger(baseline || {}, skims, now, { untrackedSwapSolTotal });
  const figures = { ...ledger, pending: ledger.pending.length };
  const refuse = (reason, extra = {}) => ({ ok: false, amountSol: 0, reason, figures: { ...figures, ...extra } });

  if (!cfg?.enabled) return refuse("skimmer is disabled (/skim on to enable)");
  if (!destination?.ok) return refuse(`destination refused: ${destination?.error || "unknown"}`);
  if (!integrity?.ok) return refuse(integrity?.reason || "skim journal not checked");
  if (ledger.pending.length > 0) return refuse(`an earlier skim (${maskAddress(ledger.pending[0].signature)}) is unresolved — no new skim until it is confirmed or expired`);
  if (inFlight.length > 0) return refuse(`busy: ${inFlight.join(", ")}`);
  if (!Number.isFinite(ledger.totalDeposited) || ledger.totalDeposited <= 0) return refuse("no deposit baseline — capital unknown");
  if (baseline?.stuck_signature) return refuse("the deposit scan is stuck on a transaction — a deposit may be unbooked");
  if (baselineFresh === false) return refuse("the deposit scan did not complete at or after the balance read — a recent deposit may be unbooked");
  // The ring keeps 300 rows; evicted rows' SOL is carried in baseline.token_swaps_evicted_sol.
  // Only a FULL ring without that running total (state from before 2026-11-25) is unknown.
  if (tokenSwapCount >= TOKEN_SWAPS_CAP && !Number.isFinite(num(tokenSwapsEvictedSol))) return refuse(`the untracked token-swap record is full (${TOKEN_SWAPS_CAP} rows) and has no running total of evicted rows — older token inflows may be missing`);

  const freeSol = fin(wallet.freeSol, NaN);
  if (!Number.isFinite(freeSol) || freeSol < 0) return refuse("wallet SOL balance unavailable");
  const before = fin(wallet.freeSolBefore, freeSol);
  const after = fin(wallet.freeSolAfter, freeSol);
  if (Math.abs(before - after) > SKIM_BALANCE_DRIFT_TOLERANCE_SOL) return refuse(`free SOL moved during the read (◎${before.toFixed(4)} → ◎${after.toFixed(4)}) — a deploy, close or transfer was in progress`);
  if (wallet.invalidReason) return refuse(wallet.invalidReason);
  if (wallet.valuationComplete === false) return refuse("position valuation incomplete");
  if (wallet.source != null && wallet.source !== "rpc") return refuse(`positions came from the ${wallet.source} fallback, not the RPC valuation`);
  const positions = Array.isArray(wallet.positions) ? wallet.positions : [];
  let positionsMarkSol = 0;
  let positionsConservativeSol = 0;
  for (const p of positions) {
    const v = fin(p?.valueSol, NaN);
    const c = fin(p?.costSol, NaN);
    if (p?.closed) return refuse("a position listed as open is closed in our records");
    if (p?.ready === false) return refuse("a position's valuation is not management-ready (pending flow / unverified)");
    if (!Number.isFinite(v) || v < 0) return refuse("an open position has no valuation");
    if (!Number.isFinite(c) || c <= 0) return refuse("an open position has no recorded cost (not adopted yet?)");
    positionsMarkSol += v;
    positionsConservativeSol += Math.min(v, c);
  }
  const freeUsed = Math.min(freeSol, before, after);
  const equityConservativeSol = freeUsed + positionsConservativeSol;
  const floorSol = Math.max(ledger.adjustedCapital, cfg.targetWorkingCapitalSol);
  const profitSol = equityConservativeSol - ledger.adjustedCapital;
  const aboveFloorSol = equityConservativeSol - floorSol;
  const cashSol = freeUsed - cfg.minWalletReserveSol;
  const capRemainingSol = cfg.maxDailyTransferSol - ledger.used24h;
  const cooldownRemainingMin = ledger.lastSkimAt ? Math.max(0, cfg.transferIntervalMin - (now - ledger.lastSkimAt) / 60000) : 0;
  Object.assign(figures, {
    freeSol: r6(freeUsed), positionsMarkSol: r6(positionsMarkSol), positionsConservativeSol: r6(positionsConservativeSol),
    unrealisedGainExcludedSol: r6(positionsMarkSol - positionsConservativeSol),
    equityConservativeSol: r6(equityConservativeSol), floorSol: r6(floorSol), profitSol: r6(profitSol),
    aboveFloorSol: r6(aboveFloorSol), reserveSol: cfg.minWalletReserveSol, cashSol: r6(cashSol),
    capRemainingSol: r6(capRemainingSol), cooldownRemainingMin: Math.ceil(cooldownRemainingMin),
  });

  const min = cfg.minTransferAmountSol;
  if (aboveFloorSol < min) {
    return refuse(profitSol < min
      ? `no realised profit to skim: equity ◎${equityConservativeSol.toFixed(4)} vs capital ◎${ledger.adjustedCapital.toFixed(4)} (profit ◎${profitSol.toFixed(4)} < ◎${min})`
      : `equity ◎${equityConservativeSol.toFixed(4)} is within ◎${min} of the target working capital ◎${cfg.targetWorkingCapitalSol.toFixed(4)}`);
  }
  if (cooldownRemainingMin > 0) return refuse(`cooldown: last skim ${Math.round((now - ledger.lastSkimAt) / 60000)} min ago, interval ${cfg.transferIntervalMin} min`);
  if (capRemainingSol < min) return refuse(`24h cap: ◎${ledger.used24h.toFixed(4)} withdrawn in the last 24 h of ◎${cfg.maxDailyTransferSol}`);
  if (cashSol < min) return refuse(`free SOL ◎${freeUsed.toFixed(4)} leaves less than ◎${min} above the ◎${cfg.minWalletReserveSol} reserve`);
  if (cfg.maxPerSkimSol < min) return refuse(`per-skim cap ◎${cfg.maxPerSkimSol} is below the minimum transfer ◎${min}`);

  const rawL = Math.floor(Math.min(aboveFloorSol, cashSol, capRemainingSol, cfg.maxPerSkimSol) * LAMPORTS);
  const minL = Math.round(min * LAMPORTS);
  const amountL = Math.floor(rawL / minL) * minL;
  if (amountL < minL) return refuse(`amount below the minimum transfer ◎${min}`);
  return { ok: true, amountSol: amountL / LAMPORTS, reason: null, figures };
}

/**
 * Proposals: one live proposal at a time (a new one supersedes the old), bound to the
 * amount, the destination, an expiry and a one-time id. In memory only — a restart
 * voids every proposal (the safe direction).
 */
export function createSkimProposalStore({ ttlMs = SKIM_PROPOSAL_TTL_MS, randomId } = {}) {
  let current = null;
  const used = new Set();
  const makeId = randomId || (() => Math.random().toString(16).slice(2, 10));
  return {
    create({ amountSol, destination, destinationMasked, source = "manual", now = Date.now() }) {
      const amt = Number(amountSol);
      if (!(amt > 0) || !destination) throw new Error("proposal needs a positive amount and a destination");
      current = { id: String(makeId()).toLowerCase(), amountSol: amt, destination, destinationMasked: destinationMasked || maskAddress(destination), source, createdAt: now, expiresAt: now + ttlMs };
      return { ...current };
    },
    peek(now = Date.now()) {
      return current && now <= current.expiresAt ? { ...current } : null;
    },
    /** Marks the proposal used BEFORE any await by the caller; a second consume fails. */
    consume(id, now = Date.now()) {
      const key = String(id ?? "").trim().toLowerCase();
      if (!key) return { ok: false, reason: "no proposal id given" };
      if (used.has(key)) return { ok: false, reason: "this proposal was already used" };
      if (!current || current.id !== key) return { ok: false, reason: "unknown or superseded proposal" };
      if (now > current.expiresAt) { current = null; return { ok: false, reason: "proposal expired" }; }
      const p = current;
      used.add(key);
      current = null;
      return { ok: true, proposal: { ...p } };
    },
    clear() { current = null; },
  };
}

/** A confirmation re-checks the decision now: it must still allow at least the proposed amount, to the same destination. */
export function confirmationRefusal(proposal, decision, destination) {
  if (!decision?.ok) return `skim no longer allowed: ${decision?.reason || "unknown"}`;
  if (!destination?.ok || destination.address !== proposal.destination) return "destination changed since the proposal";
  if (decision.amountSol + 1e-9 < proposal.amountSol) return `allowed amount fell to ◎${decision.amountSol.toFixed(4)} since the proposal of ◎${proposal.amountSol.toFixed(4)} — ask for a new one`;
  return null;
}

/** Shape checks on the Telegram update that confirms a skim (the chat/user allow-list is checked by telegram.js). */
export function skimCommandRefusal(msg = {}) {
  if (msg.chat?.type !== "private") return "skims are confirmed only in the private chat with the bot";
  if (msg.from?.is_bot) return "a bot cannot confirm a skim";
  if (msg.forward_origin || msg.forward_from || msg.forward_from_chat || msg.forward_date || msg.forward_sender_name) return "a forwarded message cannot confirm a skim";
  return null;
}

/**
 * Status of a sent skim from the chain's answers:
 *   status       getSignatureStatuses(…, { searchTransactionHistory }).value[0] (null = unknown)
 *   blockHeight  current block height or null
 *   txLookup     getTransaction on the PRIMARY RPC: undefined = not asked / failed,
 *                null = not found, { meta: { err } } = found
 * An unknown signature counts as failed only once the blockhash has expired by a margin
 * AND the primary's getTransaction also does not find it; otherwise it stays pending.
 */
export function resolveSkimStatus(skim, status, blockHeight, { txLookup, expiryMarginBlocks = 150 } = {}) {
  if (status && status.err) return "failed";
  if (status && (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized")) return "landed";
  if (txLookup && typeof txLookup === "object") return txLookup.meta?.err ? "failed" : "landed";
  if (!status && Number.isFinite(blockHeight) && Number.isFinite(skim?.last_valid_block_height)
    && blockHeight > skim.last_valid_block_height + expiryMarginBlocks && txLookup === null) return "failed";
  return "pending";
}

/** Is a transaction lookup needed before a "failed" verdict (unknown signature past expiry)? */
export function needsTxLookup(skim, status, blockHeight, { expiryMarginBlocks = 150 } = {}) {
  return !status && Number.isFinite(blockHeight) && Number.isFinite(skim?.last_valid_block_height)
    && blockHeight > skim.last_valid_block_height + expiryMarginBlocks;
}

/** /skim resolve <sig> landed|failed: allowed only when the chain's verdict agrees. */
export function operatorResolveRefusal(claim, chainVerdict, skim) {
  if (!skim) return "no such skim in the journal";
  if (skim.status !== "pending") return `that skim is already ${skim.status}`;
  if (claim !== "landed" && claim !== "failed") return "say landed or failed";
  if (chainVerdict !== claim) return `the chain says ${chainVerdict} — not recorded as ${claim}`;
  return null;
}

/** Book a landed skim as a baseline withdrawal exactly once (by signature). Mutates `baseline`; returns true when it added. */
export function bookSkimWithdrawal(baseline, { signature, amountSol, at, destinationMasked }) {
  if (!baseline || !signature) return false;
  baseline.withdrawals ??= [];
  if (baseline.withdrawals.some((w) => w?.signature === signature)) return false;
  baseline.withdrawals.push({ signature, timestamp: at, amount: Number(amountSol), reason: "profit_skim", skim: true, destination: destinationMasked || null });
  baseline.total_withdrawn = r6(Number(baseline.total_withdrawn || 0) + Number(amountSol));
  return true;
}

/** Sum of NEW non-skim withdrawals between two baseline snapshots (for the "Withdrawal detected" notice). */
export function newOperatorWithdrawalSol(beforeSigs, withdrawals = [], journalSigs = new Set()) {
  let sol = 0;
  for (const w of withdrawals) {
    if (beforeSigs.has(w?.signature) || isSkimWithdrawal(w, journalSigs)) continue;
    sol += Number(w?.amount) || 0;
  }
  return r6(sol);
}

/**
 * /skim adopt <signature> for a skim the journal does not know. Pure check of the
 * parsed transaction (getParsedTransaction on the primary RPC):
 *   - it succeeded (meta.err null), the bot wallet signed it;
 *   - its System transfers from the bot wallet go ONLY to the configured destination
 *     and sum to the expected lamports (the booked withdrawal amount, ±1 lamport);
 *   - nothing but ComputeBudget / System instructions.
 * Returns null when it may be journaled as landed, else the reason.
 */
export function adoptRefusal({ parsedTx, walletAddress, destination, expectedLamports }) {
  if (!parsedTx) return "the primary RPC does not have that transaction";
  if (parsedTx.meta?.err) return "that transaction failed on chain";
  const keys = parsedTx.transaction?.message?.accountKeys || [];
  const signer = keys.some((k) => (k.pubkey?.toBase58?.() ?? String(k.pubkey)) === walletAddress && k.signer);
  if (!signer) return "the bot wallet did not sign that transaction";
  let toDest = 0;
  for (const ix of parsedTx.transaction?.message?.instructions || []) {
    const program = ix.program ?? null;
    const pid = ix.programId?.toBase58?.() ?? String(ix.programId ?? "");
    if (program === "compute-budget" || program === "computeBudget" || pid === "ComputeBudget111111111111111111111111111111") continue;
    if (!(program === "system" || pid === SYSTEM_PROGRAM_ID)) return "that transaction does more than a SOL transfer";
    const info = ix.parsed?.info || {};
    if (ix.parsed?.type !== "transfer" || info.source !== walletAddress) return "that transaction has a System instruction that is not a transfer from the bot wallet";
    if (info.destination !== destination) return `that transaction sends SOL to ${maskAddress(info.destination)}, not the configured destination`;
    toDest += Number(info.lamports) || 0;
  }
  if (!(toDest > 0)) return "that transaction sends nothing to the configured destination";
  if (Number.isFinite(Number(expectedLamports)) && Math.abs(toDest - Number(expectedLamports)) > 1) {
    return `that transaction sent ◎${(toDest / LAMPORTS).toFixed(6)}, the booked withdrawal is ◎${(Number(expectedLamports) / LAMPORTS).toFixed(6)}`;
  }
  return null;
}

/** Race a promise against a deadline. Rejects with an Error whose `.deadline` is true. */
export function withDeadline(promise, ms, label = "step") {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { const e = new Error(`${label} took longer than ${Math.round(ms / 1000)} s`); e.deadline = true; reject(e); }, Math.max(0, ms));
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}
