import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemInstruction,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import BN from "bn.js";
import bs58 from "bs58";
import { config, computeDeployAmount, MIN_SAFE_BINS_BELOW } from "../config.js";
import { log } from "../logger.js";
import {
  trackPosition,
  markOutOfRange,
  markInRange,
  recordClaim,
  recordClaimReinvested,
  recordClose,
  getTrackedPosition,
  addGasToPosition,
  minutesOutOfRange,
  syncOpenPositions,
  updateClosedPositionPnL,
  ensureStateInitialized,
  adoptOrphanPosition,
} from "../state.js";
import { recordPerformance } from "../lessons.js";
import { getFeeEfficiencyForPool } from "../fee-efficiency.js";
import { getOrganicMomentumForPool } from "../organic-momentum.js";
import { isBaseMintOnCooldown, isPoolOnCooldown } from "../pool-memory.js";
import { normalizeMint } from "./wallet.js";
import { appendDecision } from "../decision-log.js";
import { getAndClearStagedSignals } from "../signal-tracker.js";
import { computePositions, fetchDlmmPnlForPool, getCachedSymbol, getJupiterPrices } from "./pnl.js";
import { maskUrl } from "./rpc.js";
import { getSolPriceUsd } from "../sol-price.js";

// ─── Lazy SDK loader ───────────────────────────────────────────
// @meteora-ag/dlmm → @coral-xyz/anchor uses CJS directory imports
// that break in ESM on Node 24. Dynamic import defers loading until
// an actual on-chain call is needed (never triggered in dry-run).
let _DLMM = null;
let _StrategyType = null;
let _getBinIdFromPrice = null;
let _getPriceOfBinByBinId = null;
let _getBinArrayKeysCoverage = null;
let _getBinArrayIndexesCoverage = null;
let _deriveBinArrayBitmapExtension = null;
let _isOverflowDefaultBinArrayBitmap = null;
let _BIN_ARRAY_FEE = null;
let _BIN_ARRAY_BITMAP_FEE = null;

async function getDLMM() {
  if (!_DLMM) {
    const mod = await import("@meteora-ag/dlmm");
    _DLMM = mod.default;
    _StrategyType = mod.StrategyType;
    _getBinIdFromPrice = mod.default?.getBinIdFromPrice;
    _getPriceOfBinByBinId = mod.getPriceOfBinByBinId;
    _getBinArrayKeysCoverage = mod.getBinArrayKeysCoverage;
    _getBinArrayIndexesCoverage = mod.getBinArrayIndexesCoverage;
    _deriveBinArrayBitmapExtension = mod.deriveBinArrayBitmapExtension;
    _isOverflowDefaultBinArrayBitmap = mod.isOverflowDefaultBinArrayBitmap;
    _BIN_ARRAY_FEE = mod.BIN_ARRAY_FEE;
    _BIN_ARRAY_BITMAP_FEE = mod.BIN_ARRAY_BITMAP_FEE;
  }
  return {
    DLMM: _DLMM,
    StrategyType: _StrategyType,
    getBinIdFromPrice: _getBinIdFromPrice,
    getPriceOfBinByBinId: _getPriceOfBinByBinId,
    getBinArrayKeysCoverage: _getBinArrayKeysCoverage,
    getBinArrayIndexesCoverage: _getBinArrayIndexesCoverage,
    deriveBinArrayBitmapExtension: _deriveBinArrayBitmapExtension,
    isOverflowDefaultBinArrayBitmap: _isOverflowDefaultBinArrayBitmap,
    BIN_ARRAY_FEE: _BIN_ARRAY_FEE,
    BIN_ARRAY_BITMAP_FEE: _BIN_ARRAY_BITMAP_FEE,
  };
}

// ─── Lazy wallet/connection init ──────────────────────────────
// Avoids crashing on import when WALLET_PRIVATE_KEY is not yet set
// (e.g. during screening-only tests).
let _connection = null;
let _wallet = null;

function getConnection() {
  if (!_connection) {
    _connection = new Connection(process.env.RPC_URL, { commitment: "confirmed", disableRequestBatching: true });
  }
  return _connection;
}

// ─── Priority Fee + Transaction Retry ──────────────────────────
//
// Urgency tiers (AutoLP-Orca pattern): "normal" pegs to the median recent
// prioritization fee (existing behavior, unchanged); "exit" pegs to the 75th
// percentile with a higher multiplier and a higher cap, because a failed
// close during a crash/rug costs far more than any tip — congestion is
// exactly when a static/median fee fails to land.
//
// Worst-case tip cost at the exit cap (maxExitPriorityFeeMicroLamports, default
// 3,000,000 µL/CU): setComputeUnitPrice's `microLamports` is a price PER
// COMPUTE UNIT, not a flat fee — total priority fee (lamports) =
// microLamports * computeUnitLimit / 1e6. The Meteora DLMM SDK sets its own
// setComputeUnitLimit on these transactions; the highest ceiling it ever uses
// (addLiquidity/swap-heavy paths, see @meteora-ag/dlmm dist) is 1,400,000 CU.
// So worst case: 3,000,000 µL * 1,400,000 CU / 1e6 = 4,200,000 lamports =
// 0.0042 SOL. Close/removeLiquidity paths (the ones actually tagged "exit")
// don't set an explicit CU limit that high in practice — typical DLMM
// instructions run 100k-400k CU — so the realistic worst-case tip is well
// under 0.001 SOL; 1,400,000 CU is the SDK's own absolute ceiling used as the
// conservative sanity bound. At positions ~1.57 SOL (~$126), a ~0.001-0.004
// SOL tip to guarantee a close lands during a crash is strictly worth it.
let _cachedPriorityFee = { value: 0, fetchedAt: 0 };
let _cachedExitPriorityFee = { value: 0, fetchedAt: 0 };
const PRIORITY_FEE_CACHE_MS = 30_000; // cache for 30s to avoid hammering RPC

/**
 * Pure percentile-fee calculator — no I/O, easy to unit test directly.
 * @param {Array<{prioritizationFee: number}|number>} fees - raw getRecentPrioritizationFees() entries or plain numbers
 * @param {{percentile?: number, multiplier?: number, cap?: number}} opts
 * @returns {number} microLamports, clamped to [0, cap]
 */
export function computePriorityFee(fees, { percentile = 0.5, multiplier = 1.2, cap = 1_000_000 } = {}) {
  if (!Array.isArray(fees) || fees.length === 0) return 0;
  const values = fees
    .map((f) => (typeof f === "number" ? f : f?.prioritizationFee))
    .map(Number)
    .filter((f) => Number.isFinite(f) && f > 0)
    .sort((a, b) => a - b);
  if (values.length === 0) return 0;
  const p = Math.min(1, Math.max(0, percentile));
  const idx = Math.min(values.length - 1, Math.floor(values.length * p));
  const base = values[idx];
  return Math.min(Math.round(base * multiplier), cap);
}

async function getDynamicPriorityFee(urgency = "normal") {
  const isExit = urgency === "exit";
  if (isExit) {
    if (!config.tx?.exitPriorityFeeEnabled) return getDynamicPriorityFee("normal");
  } else if (!config.tx?.enablePriorityFees) {
    return 0;
  }

  const cache = isExit ? _cachedExitPriorityFee : _cachedPriorityFee;
  if (Date.now() - cache.fetchedAt < PRIORITY_FEE_CACHE_MS) {
    return cache.value;
  }
  try {
    const conn = getConnection();
    const fees = await conn.getRecentPrioritizationFees();
    const fee = isExit
      ? computePriorityFee(fees, {
          percentile: 0.75,
          multiplier: config.tx?.exitPriorityFeeMultiplier ?? 1.5,
          cap: config.tx?.maxExitPriorityFeeMicroLamports ?? 3_000_000,
        })
      : computePriorityFee(fees, {
          percentile: 0.5,
          multiplier: config.tx?.priorityFeeMultiplier ?? 1.2,
          cap: config.tx?.maxPriorityFeeMicroLamports ?? 1_000_000,
        });
    if (isExit) _cachedExitPriorityFee = { value: fee, fetchedAt: Date.now() };
    else _cachedPriorityFee = { value: fee, fetchedAt: Date.now() };
    return fee;
  } catch (e) {
    log("tx_priority", `Priority fee fetch failed (${urgency}): ${e.message}`);
    return cache.value; // return stale cache on error
  }
}

/**
 * Set (or replace) the ComputeBudget priority-fee instruction on a legacy
 * Transaction. Replacing rather than skipping-if-present lets retry
 * escalation (sendAndConfirmWithRetry) bump the fee on each attempt.
 */
const COMPUTE_UNIT_PRICE_DISCRIMINATOR = 3; // ComputeBudgetProgram: 2=SetComputeUnitLimit, 3=SetComputeUnitPrice

async function prependPriorityFee(tx, urgency = "normal", overrideMicroLamports = null) {
  if (!(tx instanceof Transaction)) return; // skip VersionedTransaction
  const microLamports = overrideMicroLamports ?? (await getDynamicPriorityFee(urgency));
  if (microLamports <= 0) return;
  // Match only an existing SetComputeUnitPrice ix (not SetComputeUnitLimit, which the
  // DLMM SDK sometimes prepends itself) — matching on programId alone would either
  // wrongly skip adding our price ix or clobber the SDK's CU limit ix.
  const existingIdx = tx.instructions?.findIndex((ix) =>
    ix.programId?.equals?.(ComputeBudgetProgram.programId) && ix.data?.[0] === COMPUTE_UNIT_PRICE_DISCRIMINATOR
  );
  const priceIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports });
  if (existingIdx != null && existingIdx >= 0) {
    tx.instructions[existingIdx] = priceIx;
  } else {
    tx.instructions.unshift(priceIx);
  }
  log("tx_priority", `Set priority fee (${urgency}): ${microLamports} µL`);
}

/**
 * Look up the actual fee paid for a confirmed tx (lamports), retrying because
 * getTransaction is frequently not yet queryable in the moment right after
 * confirmation. Falls back to the 5000-lamport base fee only if every attempt
 * misses (so accounting degrades to a floor rather than throwing).
 */
export async function fetchTxFeeLamports(conn, txHash, { attempts = 4, delayMs = 800 } = {}) {
  for (let i = 0; i < attempts; i++) {
    try {
      const txMeta = await conn.getTransaction(txHash, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      if (txMeta?.meta?.fee) return txMeta.meta.fee;
    } catch (_) { /* not indexed yet — retry */ }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  return 5000;
}

// Label prefixes that are exit-intent (closes + the flip tactic's withdraw/re-add
// steps, which are on-chain liquidity-removal operations same as a close). Deploys
// and standalone fee claims stay "normal" — derived from the label rather than a
// new options param so none of the 10 existing call sites need to change; the
// label already encodes intent ("close:...", "flip:...", "deploy:...", "claim:...").
const EXIT_URGENCY_LABEL_PREFIXES = ["close:", "flip:"];

function urgencyForLabel(label) {
  return EXIT_URGENCY_LABEL_PREFIXES.some((prefix) => String(label || "").startsWith(prefix))
    ? "exit"
    : "normal";
}

async function sendAndConfirmWithRetry(conn, tx, signers, label, maxRetries) {
  const retries = maxRetries ?? config.tx?.txMaxRetries ?? 2;
  const urgency = urgencyForLabel(label);
  await prependPriorityFee(tx, urgency);
  let lastSig = null; // signature broadcast by the most recent attempt, if the error surfaced it
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      if (attempt > 0) {
        // Before resubmitting, check whether the prior attempt's tx already landed.
        // Close/claim txs are non-idempotent (a double remove/claim would double-
        // execute), so a silently-confirmed prior send must not be resubmitted just
        // because the confirmation await timed out on a stale blockhash.
        if (lastSig) {
          try {
            const { value } = await conn.getSignatureStatuses([lastSig]);
            const st = value?.[0];
            if (st && !st.err && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) {
              log("tx_retry", `${label}: prior tx ${lastSig} already landed (${st.confirmationStatus}); not resubmitting`);
              const fee = await fetchTxFeeLamports(conn, lastSig);
              return { txHash: lastSig, fee };
            }
          } catch (statusErr) {
            log("tx_retry", `${label}: could not verify prior tx status (${statusErr?.message || statusErr}); resubmitting`);
          }
        }
        const { blockhash } = await conn.getLatestBlockhash("confirmed");
        tx.recentBlockhash = blockhash;
        // Exit-urgency retries escalate the tip rather than resending at the same
        // price — a failed close during congestion should bid higher, not identically.
        // Safe to REPLACE (not add a second) setComputeUnitPrice ix: prependPriorityFee
        // finds the existing SetComputeUnitPrice instruction by discriminator and
        // overwrites it in place; Transaction.instructions is a plain array we own
        // (not yet compiled/signed at this point), so in-place replacement is fine.
        if (urgency === "exit" && config.tx?.exitPriorityFeeEnabled) {
          const bumped = Math.min(
            Math.round((await getDynamicPriorityFee("exit")) * Math.pow(1.5, attempt)),
            config.tx?.maxExitPriorityFeeMicroLamports ?? 3_000_000,
          );
          await prependPriorityFee(tx, urgency, bumped);
          log("tx_retry", `${label}: retry ${attempt}/${retries}, new blockhash, escalated fee to ${bumped} µL`);
        } else {
          log("tx_retry", `${label}: retry ${attempt}/${retries}, new blockhash`);
        }
      }
      const txHash = await sendAndConfirmTransaction(conn, tx, signers);
      // Look up the actual fee paid (includes priority fee), with retries.
      const fee = await fetchTxFeeLamports(conn, txHash);
      if (fee <= 5000) log("tx_gas", `${label}: fee lookup returned floor (${fee} lamports) — may be undercounted`);
      return { txHash, fee };
    } catch (e) {
      // Capture the broadcast signature so the next attempt's guard can check
      // whether it landed before resubmitting. Expiry/timeout errors carry it on
      // `.signature`; otherwise scrape it from the message ("Signature <sig> …").
      if (typeof e?.signature === "string" && e.signature) {
        lastSig = e.signature;
      } else {
        const sm = /signature\s+([1-9A-HJ-NP-Za-km-z]{43,88})/i.exec(String(e?.message || ""));
        if (sm) lastSig = sm[1];
      }
      const retryable = e.name === "TransactionExpiredBlockheightExceededError"
                     || e.message?.includes("Blockhash not found")
                     || e.message?.includes("block height exceeded");
      if (attempt < retries && retryable) {
        log("tx_retry", `${label}: attempt ${attempt + 1} failed (${e.message}), retrying...`);
        await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
        continue;
      }
      const { recordError } = await import("../error-telemetry.js");
      recordError("tx_failed", `${label} failed: ${e.message}`);
      throw e;
    }
  }
}

// ─── Gas Estimation Helpers ────────────────────────────────────

/**
 * Estimate the total gas cost (in SOL) for a full deploy-close-swap cycle.
 * Uses recent priority fee data + known tx counts.
 */
export function estimateCycleGasCost(isWideRange = false) {
  const baseFee = 5000; // lamports per tx (Solana base fee)
  const priorityFee = _cachedPriorityFee?.value ?? 0;
  const perTxLamports = baseFee + priorityFee;

  const deployTxs = isWideRange ? 3 : 1;
  const closeTxs = 3;
  const swapTxs = 1;
  const totalTxs = deployTxs + closeTxs + swapTxs;

  return (totalTxs * perTxLamports) / 1e9; // SOL
}

/**
 * Calculate minimum minutes a position must stay in-range to break even on gas.
 * @param {number} gasCostSol - estimated cycle gas cost
 * @param {number} feeTvlRatio24h - pool's 24h fee/TVL ratio (e.g. 0.5 = 0.5%)
 * @param {number} deploySol - amount deployed in SOL
 * @returns {number} minutes to break even
 */
export function gasBreakEvenMinutes(gasCostSol, feeTvlRatio24h, deploySol) {
  if (!feeTvlRatio24h || feeTvlRatio24h <= 0 || !deploySol) return Infinity;
  const yieldPerMinute = (feeTvlRatio24h / 100) * deploySol / 1440;
  if (yieldPerMinute <= 0) return Infinity;
  return gasCostSol / yieldPerMinute;
}

/**
 * Estimate the SOL cost of a claim+re-add compound cycle (2 txs at "normal"
 * urgency: claimSwapFee + addLiquidityByStrategy on the existing position —
 * same pattern as flipPositionInPlace's removeLiquidity+addLiquidity pair,
 * just without the withdraw step since we're adding fresh SOL, not re-adding
 * withdrawn liquidity). Mirrors estimateCycleGasCost's shape: Solana base fee
 * (5000 lamports) + the cached median priority fee per tx, no wide-range
 * chunking (a compound add is always a tight strip, never >69 bins).
 *
 * Rent is NOT included: both txs act on bins/accounts the position already
 * owns (claim writes to existing token accounts, add-liquidity uses bins
 * already covered by the position's own range), so no new rent-exempt
 * account is created in the common case. This can undercount if the SDK
 * needs to init a bin array the position doesn't already span (e.g. a
 * re-add strategy that reaches new bins) — callers re-adding strictly
 * within the position's existing lower/upper bin range (the only mode this
 * file implements) are unaffected.
 */
export function estimateCompoundGasCost() {
  const baseFee = 5000; // lamports per tx (Solana base fee)
  const priorityFee = _cachedPriorityFee?.value ?? 0;
  const perTxLamports = baseFee + priorityFee;
  const claimTxs = 1;
  const addTxs = 1;
  return ((claimTxs + addTxs) * perTxLamports) / 1e9; // SOL
}

/**
 * Estimate the SOL gas cost of the EXIT leg only — claim + close + swap — reusing
 * the same per-tx model as estimateCycleGasCost/estimateCompoundGasCost (Solana
 * base fee 5000 lamports + the cached median priority fee per tx). This is the
 * closing cost the close-efficiency gate subtracts from gross pnl (a trailing-TP
 * close pays claim → close → base→SOL swap), so it deliberately excludes the
 * deploy tx that estimateCycleGasCost includes. Conservative constant model —
 * exit-urgency priority fees can run higher, but the gate ships shadow-first and
 * is calibrated against live [CLOSE_EFF_SHADOW] logs before enabling.
 */
export function estimateExitGasCost() {
  const baseFee = 5000; // lamports per tx (Solana base fee)
  const priorityFee = _cachedPriorityFee?.value ?? 0;
  const perTxLamports = baseFee + priorityFee;
  const claimTxs = 1;
  const closeTxs = 3;
  const swapTxs = 1;
  return ((claimTxs + closeTxs + swapTxs) * perTxLamports) / 1e9; // SOL
}

/**
 * Profitability gate (Revert Compoundor pattern): only compound when the
 * unclaimed SOL-side fees clear the round-trip cost by a healthy multiple —
 * NOT merely covering it, since claim+re-add gas is a sunk cost paid
 * whether or not the compounded capital ever earns it back (a razor-thin
 * "barely profitable" compound is a coin flip once slippage/timing noise is
 * considered). Pure function — no I/O, easy to unit test directly.
 *
 * @param {number} unclaimed_fees_sol - SOL-side unclaimed fees (positionData.feeY, lamports→SOL)
 * @param {number} est_gas_sol - estimated round-trip gas cost (see estimateCompoundGasCost)
 * @param {number} min_multiple - fees must be >= this many times est_gas_sol (default 5)
 * @param {number} min_fees_sol - absolute floor regardless of multiple (default 0.01)
 * @returns {boolean}
 */
export function shouldCompound({ unclaimed_fees_sol, est_gas_sol, min_multiple = 5, min_fees_sol = 0.01 }) {
  const fees = Number(unclaimed_fees_sol);
  const gas = Number(est_gas_sol);
  const multiple = Number(min_multiple);
  const floor = Number(min_fees_sol);
  if (!Number.isFinite(fees) || fees <= 0) return false;
  if (!Number.isFinite(gas) || gas < 0) return false;
  if (!Number.isFinite(multiple) || multiple < 0) return false;
  if (!Number.isFinite(floor) || floor < 0) return false;
  // gas=0 (e.g. no priority-fee data cached yet) still requires clearing min_fees_sol —
  // the multiple check alone would pass trivially (fees >= 5*0 is always true).
  const bar = Math.max(floor, multiple * gas);
  return fees >= bar;
}

function getWallet() {
  if (!_wallet) {
    if (!process.env.WALLET_PRIVATE_KEY) {
      throw new Error("WALLET_PRIVATE_KEY not set");
    }
    _wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
    log("init", `Wallet: ${_wallet.publicKey.toString()}`);
  }
  return _wallet;
}

function getMeridianApiBase() {
  return String(config.api.url || "https://api.agentmeridian.xyz/api").replace(/\/+$/, "");
}

function getMeridianHeaders() {
  const headers = { "Content-Type": "application/json" };
  if (config.api.publicApiKey) {
    headers["x-api-key"] = config.api.publicApiKey;
  }
  return headers;
}

function shouldUseLpAgentRelay() {
  return !!config.api.lpAgentRelayEnabled;
}

function shouldUseLpAgentRelayForDeploy() {
  return false;
}

async function meridianJson(pathname, options = {}) {
  const { retry, ...fetchOptions } = options;
  if (!retry) {
    return meridianJsonOnce(pathname, fetchOptions);
  }

  const maxElapsedMs = Number(retry.maxElapsedMs || 30_000);
  const maxAttempts = Number(retry.maxAttempts || 10);
  const startedAt = Date.now();
  let attempt = 0;
  let lastError = null;

  while (Date.now() - startedAt < maxElapsedMs && attempt < maxAttempts) {
    const elapsedMs = Date.now() - startedAt;
    const remainingMs = Math.max(1, maxElapsedMs - elapsedMs);
    try {
      return await meridianJsonOnce(
        pathname,
        fetchOptions,
        Math.min(Number(retry.perAttemptTimeoutMs || 10_000), remainingMs),
      );
    } catch (error) {
      lastError = error;
      if (!isRetryableMeridianError(error) || attempt >= maxAttempts - 1) {
        throw error;
      }
      const waitMs = Math.min(meridianRetryDelayMs(error, attempt), Math.max(0, remainingMs - 1));
      if (waitMs <= 0) break;
      await sleep(waitMs);
      attempt += 1;
    }
  }

  throw lastError || new Error(`${pathname} retry budget exhausted`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableMeridianStatus(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function isRetryableMeridianError(error) {
  if (isRetryableMeridianStatus(Number(error?.status || 0))) return true;
  const name = String(error?.name || "");
  const message = String(error?.message || "").toLowerCase();
  return name === "AbortError" ||
    message.includes("aborted") ||
    message.includes("fetch failed") ||
    message.includes("network");
}

function meridianRetryDelayMs(error, attempt) {
  const retryAfter = Number(error?.retryAfter);
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1000, 10_000);
  }
  return Math.min(500 * 2 ** attempt, 5_000);
}

async function meridianFetchWithTimeout(url, options, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return fetch(url, options);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signal = options.signal;
  const abortFromParent = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", abortFromParent, { once: true });
  }

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", abortFromParent);
  }
}

async function meridianJsonOnce(pathname, options = {}, timeoutMs = null) {
  const res = await meridianFetchWithTimeout(`${getMeridianApiBase()}${pathname}`, options, timeoutMs);
  const text = await res.text().catch(() => "");
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }
  if (!res.ok) {
    const error = new Error(payload?.error || `${pathname} ${res.status}`);
    error.status = res.status;
    error.payload = payload;
    error.retryAfter = res.headers.get("retry-after");
    throw error;
  }
  return payload;
}

function signSerializedTransaction(serialized, wallet) {
  const bytes = Buffer.from(serialized, "base64");
  try {
    const versioned = VersionedTransaction.deserialize(bytes);
    versioned.sign([wallet]);
    return Buffer.from(versioned.serialize()).toString("base64");
  } catch {
    const legacy = Transaction.from(bytes);
    legacy.partialSign(wallet);
    return legacy
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString("base64");
  }
}

function deserializeSignedTransaction(signedBase64) {
  const bytes = Buffer.from(signedBase64, "base64");
  try {
    return VersionedTransaction.deserialize(bytes);
  } catch {
    return Transaction.from(bytes);
  }
}

function getStaticAccountKeyStrings(tx) {
  if (tx instanceof VersionedTransaction) {
    return tx.message.staticAccountKeys.map((key) => key.toString());
  }
  return tx.compileMessage().accountKeys.map((key) => key.toString());
}

function getTransactionInstructions(tx) {
  if (!(tx instanceof VersionedTransaction)) return tx.instructions;

  const keys = tx.message.staticAccountKeys;
  return tx.message.compiledInstructions
    .map((ix) => {
      const programId = keys[ix.programIdIndex];
      if (!programId) return null;
      const accounts = ix.accountKeyIndexes
        .map((accountIndex) => keys[accountIndex])
        .filter(Boolean);
      return new TransactionInstruction({
        programId,
        keys: accounts.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })),
        data: Buffer.from(ix.data),
      });
    })
    .filter(Boolean);
}

function assertNoUnsafeSystemTransfer(tx, wallet, allowedDestinations = []) {
  const owner = wallet.publicKey.toString();
  const allowed = new Set(allowedDestinations.filter(Boolean).map(String));

  for (const ix of getTransactionInstructions(tx)) {
    if (!ix.programId.equals(SystemProgram.programId)) continue;

    let type = null;
    try {
      type = SystemInstruction.decodeInstructionType(ix);
    } catch {
      continue;
    }
    if (type !== "Transfer" && type !== "TransferWithSeed") continue;

    const decoded = type === "Transfer"
      ? SystemInstruction.decodeTransfer(ix)
      : SystemInstruction.decodeTransferWithSeed(ix);
    const source = decoded.fromPubkey?.toString();
    const destination = decoded.toPubkey?.toString();
    if (source === owner && !allowed.has(destination)) {
      throw new Error(
        `Relay transaction contains direct SOL transfer from owner to ${destination?.slice(0, 8) || "unknown"}.`,
      );
    }
  }
}

function signSerializedTransactions(serializedTxs, wallet) {
  return (serializedTxs || [])
    .filter((entry) => typeof entry === "string" && entry.length > 0)
    .map((entry) => signSerializedTransaction(entry, wallet));
}

async function signAndSimulateRelayTransactions(serializedTxs, wallet, {
  label,
  allowedDebitMints = [],
  allowedSystemTransferDestinations = [],
  maxSolLoss = 0.05,
  requiredStaticAccounts = [],
} = {}) {
  const signed = [];
  const owner = wallet.publicKey.toString();
  const allowedMints = new Set(allowedDebitMints.filter(Boolean).map(String));
  const maxLamportLoss = Math.floor(Number(maxSolLoss) * 1e9);

  for (const [index, serialized] of (serializedTxs || []).entries()) {
    if (typeof serialized !== "string" || serialized.length === 0) continue;

    const signedBase64 = signSerializedTransaction(serialized, wallet);
    const tx = deserializeSignedTransaction(signedBase64);
    assertNoUnsafeSystemTransfer(tx, wallet, allowedSystemTransferDestinations);
    const staticKeys = getStaticAccountKeyStrings(tx);
    for (const account of requiredStaticAccounts.filter(Boolean)) {
      if (!staticKeys.includes(String(account))) {
        throw new Error(`Relay ${label || "transaction"} ${index + 1} missing required account ${String(account).slice(0, 8)}.`);
      }
    }

    const ownerIndex = staticKeys.indexOf(owner);
    const simulation = await getConnection().simulateTransaction(tx, {
      sigVerify: false,
      replaceRecentBlockhash: false,
    });
    const value = simulation.value;
    if (value.err) {
      throw new Error(`Relay ${label || "transaction"} ${index + 1} simulation failed: ${JSON.stringify(value.err)}`);
    }

    if (ownerIndex >= 0 && value.preBalances?.[ownerIndex] != null && value.postBalances?.[ownerIndex] != null) {
      const lamportDelta = value.postBalances[ownerIndex] - value.preBalances[ownerIndex];
      if (lamportDelta < -maxLamportLoss) {
        throw new Error(
          `Relay ${label || "transaction"} ${index + 1} would debit ${(Math.abs(lamportDelta) / 1e9).toFixed(6)} SOL from owner.`,
        );
      }
    }

    const preByMint = new Map();
    for (const balance of value.preTokenBalances || []) {
      if (balance.owner !== owner) continue;
      preByMint.set(balance.mint, BigInt(balance.uiTokenAmount?.amount || "0"));
    }
    for (const balance of value.postTokenBalances || []) {
      if (balance.owner !== owner) continue;
      const preAmount = preByMint.get(balance.mint) ?? 0n;
      const postAmount = BigInt(balance.uiTokenAmount?.amount || "0");
      if (postAmount < preAmount && !allowedMints.has(balance.mint)) {
        throw new Error(
          `Relay ${label || "transaction"} ${index + 1} would debit unrelated token mint ${balance.mint}.`,
        );
      }
      preByMint.delete(balance.mint);
    }
    for (const [mint, preAmount] of preByMint) {
      if (preAmount > 0n && !allowedMints.has(mint)) {
        throw new Error(`Relay ${label || "transaction"} ${index + 1} would close/debit unrelated token mint ${mint}.`);
      }
    }

    signed.push(signedBase64);
  }

  return signed;
}

function normalizeExecutionSignatures(result) {
  const signatures = [];
  const seen = new Set();
  for (const value of []
    .concat(result?.signatures || [])
    .concat(result?.result?.txHashes || [])
    .concat(result?.result?.signatures || [])
    .concat(result?.result?.signature ? [result.result.signature] : [])) {
    if (typeof value !== "string" || !value) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    signatures.push(value);
  }
  return signatures;
}

const METEORA_INIT_BIN_ARRAY_DISCRIMINATOR = Buffer.from([35, 86, 19, 185, 78, 212, 75, 211]).toString("hex");
const METEORA_INIT_BITMAP_EXTENSION_DISCRIMINATOR = Buffer.from([47, 157, 226, 180, 12, 240, 33, 71]).toString("hex");

function getDlmmProgramId() {
  return new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
}

function formatSolFee(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number.toFixed(8).replace(/0+$/, "").replace(/\.$/, "") : "unknown";
}

async function assertRangeDoesNotRequireBinArrayInitialization(pool, minBinId, maxBinId) {
  const {
    getBinArrayKeysCoverage,
    getBinArrayIndexesCoverage,
    deriveBinArrayBitmapExtension,
    isOverflowDefaultBinArrayBitmap,
    BIN_ARRAY_FEE,
    BIN_ARRAY_BITMAP_FEE,
  } = await getDLMM();

  if (!getBinArrayKeysCoverage || !getBinArrayIndexesCoverage) {
    throw new Error("Cannot verify Meteora bin-array initialization risk; refusing deploy.");
  }

  const programId = getDlmmProgramId();
  const poolPubkey = new PublicKey(pool.pubkey?.toString?.() || pool.lbPair?.publicKey?.toString?.() || pool.lbPair?.pubkey?.toString?.());
  const lower = new BN(Math.min(minBinId, maxBinId));
  const upper = new BN(Math.max(minBinId, maxBinId));
  const indexes = getBinArrayIndexesCoverage(lower, upper);
  const keys = getBinArrayKeysCoverage(lower, upper, poolPubkey, programId);
  const accounts = await getConnection().getMultipleAccountsInfo(keys, "confirmed");
  const missing = accounts
    .map((account, index) => account ? null : {
      index: indexes[index]?.toString?.() ?? String(index),
      address: keys[index].toString(),
    })
    .filter(Boolean);

  if (missing.length > 0) {
    const totalFee = missing.length * Number(BIN_ARRAY_FEE ?? 0.07143744);
    const sample = missing.slice(0, 3).map((entry) => `${entry.index}:${entry.address.slice(0, 8)}`).join(", ");
    throw new Error(
      `Deploy skipped: selected range requires ${missing.length} missing Meteora bin-array initialization(s) ` +
      `(~${formatSolFee(totalFee)} SOL non-refundable pool rent; ${formatSolFee(BIN_ARRAY_FEE ?? 0.07143744)} SOL each). ` +
      `Missing indexes: ${sample}${missing.length > 3 ? ", ..." : ""}. Pick an already-initialized range/pool.`,
    );
  }

  if (deriveBinArrayBitmapExtension && isOverflowDefaultBinArrayBitmap) {
    const needsBitmapExtension = indexes.some((index) => isOverflowDefaultBinArrayBitmap(index));
    if (needsBitmapExtension) {
      const [bitmapExtension] = deriveBinArrayBitmapExtension(poolPubkey, programId);
      const account = await getConnection().getAccountInfo(bitmapExtension, "confirmed");
      if (!account) {
        throw new Error(
          `Deploy skipped: selected range requires Meteora bin-array bitmap extension initialization ` +
          `(~${formatSolFee(BIN_ARRAY_BITMAP_FEE ?? 0.01180416)} SOL non-refundable pool rent). Pick a closer initialized range/pool.`,
        );
      }
    }
  }
}

function assertNoInitializeBinArrayInstructions(serializedTxs) {
  const offenders = [];
  for (const serialized of serializedTxs || []) {
    if (typeof serialized !== "string" || serialized.length === 0) continue;
    for (const discriminator of getDlmmInstructionDiscriminators(serialized)) {
      if (discriminator === METEORA_INIT_BIN_ARRAY_DISCRIMINATOR) {
        offenders.push("initializeBinArray");
      } else if (discriminator === METEORA_INIT_BITMAP_EXTENSION_DISCRIMINATOR) {
        offenders.push("initializeBinArrayBitmapExtension");
      }
    }
  }
  if (offenders.length > 0) {
    throw new Error(
      `Deploy skipped: generated transaction includes Meteora ${[...new Set(offenders)].join(" / ")} ` +
      "instruction(s), which would charge non-refundable pool initialization rent.",
    );
  }
}

function getDlmmInstructionDiscriminators(serialized) {
  const bytes = Buffer.from(serialized, "base64");
  const dlmmProgramId = getDlmmProgramId().toString();
  try {
    const versioned = VersionedTransaction.deserialize(bytes);
    return versioned.message.compiledInstructions
      .map((ix) => {
        const programId = versioned.message.staticAccountKeys[ix.programIdIndex]?.toString();
        if (programId !== dlmmProgramId) return null;
        return Buffer.from(ix.data || []).subarray(0, 8).toString("hex");
      })
      .filter(Boolean);
  } catch {
    const legacy = Transaction.from(bytes);
    return legacy.instructions
      .map((ix) => ix.programId.toString() === dlmmProgramId ? Buffer.from(ix.data || []).subarray(0, 8).toString("hex") : null)
      .filter(Boolean);
  }
}

// ─── Pool Cache ────────────────────────────────────────────────
const poolCache = new Map();
const poolMetadataCache = new Map();

async function getPool(poolAddress) {
  const key = poolAddress.toString();
  if (!poolCache.has(key)) {
    const { DLMM } = await getDLMM();
    const pool = await DLMM.create(getConnection(), new PublicKey(poolAddress));
    poolCache.set(key, pool);
  }
  return poolCache.get(key);
}

setInterval(() => poolCache.clear(), 5 * 60 * 1000);
setInterval(() => poolMetadataCache.clear(), 15 * 60 * 1000);

export async function getPoolMetadata(poolAddress) {
  const key = String(poolAddress);
  if (poolMetadataCache.has(key)) {
    return poolMetadataCache.get(key);
  }

  try {
    const res = await fetch(`https://dlmm.datapi.meteora.ag/pools/${key}`);
    if (!res.ok) {
      throw new Error(`Pool metadata API ${res.status}`);
    }

    const data = await res.json();
    const tokenX = data?.token_x?.symbol || null;
    const tokenY = data?.token_y?.symbol || null;
    const pair = data?.name || (tokenX && tokenY ? `${tokenX}-${tokenY}` : null);
    const meta = {
      address: data?.address || key,
      name: pair,
      token_x_symbol: tokenX,
      token_y_symbol: tokenY,
    };
    poolMetadataCache.set(key, meta);
    return meta;
  } catch (error) {
    log("pool_meta_warn", `Pool metadata lookup failed for ${key.slice(0, 8)}: ${error.message}`);
    const fallback = { address: key, name: null, token_x_symbol: null, token_y_symbol: null };
    poolMetadataCache.set(key, fallback);
    return fallback;
  }
}

// ─── Get Active Bin ────────────────────────────────────────────
export async function getActiveBin({ pool_address }) {
  pool_address = normalizeMint(pool_address);
  const pool = await getPool(pool_address);
  const activeBin = await pool.getActiveBin();

  return {
    binId: activeBin.binId,
    price: pool.fromPricePerLamport(Number(activeBin.price)),
    pricePerLamport: activeBin.price.toString(),
  };
}

/**
 * Verify whether a "failed" deploy actually landed on-chain, and adopt it if so.
 *
 * The failure mode this closes: a deploy transaction bundle reports failure
 * (e.g. simulation error on one instruction — the CRED-SOL 2026-07-17 case:
 * `InvalidBinArray` on RebalanceLiquidity) while the addLiquidity instruction
 * that mints the position actually confirms. The old code returned
 * `success:false` and never tracked the position, orphaning live capital that
 * only surfaced via a manual Telegram drift alert.
 *
 * Called from deployPosition's catch blocks. Refreshes on-chain positions and
 * looks for one this deploy would have created: by exact position pubkey when
 * known (standard SDK path), else by pool + bin range (relay path, address not
 * known up-front). If found and not already tracked open, adopts it with the
 * full deploy context we still hold. Best-effort and fail-open: any error here
 * just lets the original failure stand.
 *
 * @returns {Promise<object|null>} the adopted on-chain position, or null
 */
async function recoverLandedDeploy({ positionPubkey = null, pool_address, minBinId, maxBinId, extra = {} }) {
  try {
    // Give the bundle a moment to confirm, then force a fresh on-chain read.
    await new Promise((r) => setTimeout(r, 4000));
    _positionsCacheAt = 0;
    const refreshed = await getMyPositions({ force: true, silent: true }).catch(() => null);
    const list = refreshed?.positions || [];
    if (!list.length) return null;

    const match = positionPubkey
      ? list.find((p) => p.position === positionPubkey)
      : (list.find((p) => p.pool === pool_address && p.lower_bin === minBinId && p.upper_bin === maxBinId)
         || list.find((p) => p.pool === pool_address));
    if (!match) return null;

    // If it's already tracked & open, another path (or a prior retry) handled it.
    const tracked = getTrackedPosition(match.position);
    if (tracked && !tracked.closed) return match;

    const adopted = adoptOrphanPosition(match, {
      reason: "post-failure deploy verification",
      extra: {
        min_bin: minBinId,
        max_bin: maxBinId,
        ...extra,
      },
    });
    if (adopted) {
      log("deploy", `Recovered orphaned deploy: ${match.position} (${match.pair}) landed despite reported failure — adopted into state`);
      return match;
    }
    return null;
  } catch (e) {
    log("deploy_error", `Post-failure deploy verification failed: ${e.message}`);
    return null;
  }
}

// ─── Deploy Position ───────────────────────────────────────────
export async function deployPosition({
  pool_address,
  amount_sol, // legacy: will be used as amount_y if amount_y is not provided
  amount_x,
  amount_y,
  strategy,
  shape,
  bins_below,
  bins_above,
  downside_pct,
  upside_pct,
  // optional pool metadata for learning (passed by agent when available)
  pool_name,
  bin_step,
  base_fee,
  volatility,
  fee_tvl_ratio,
  organic_score,
  initial_value_usd,
  // entry market conditions (injected by executor safety checks)
  entry_mcap,
  entry_tvl,
  entry_volume,
  entry_holders,
  lazy = false,
}) {
  await ensureStateInitialized();
  pool_address = normalizeMint(pool_address);
  let activeStrategy = strategy || config.strategy.strategy;
  let activeBinsBelow = bins_below;
  let activeBinsAbove = bins_above;
  const parsedVolatility = volatility == null ? null : Number(volatility);
  const normalizedVolatility = parsedVolatility != null && Number.isFinite(parsedVolatility) ? parsedVolatility : null;

  if (volatility != null && (normalizedVolatility == null || normalizedVolatility <= 0)) {
    throw new Error(`Invalid volatility ${volatility} — refusing deploy because the volatility feed is unusable.`);
  }

  if (activeStrategy === "dynamic" || activeStrategy === "mixed") {
    const threshold = config.strategy.dynamicVolatilityThreshold ?? 1.5;
    if (normalizedVolatility != null) {
      if (normalizedVolatility >= threshold) {
        activeStrategy = "bid_ask";
        log("deploy", `Dynamic strategy: resolved to 'bid_ask' (volatility ${normalizedVolatility.toFixed(4)} >= threshold ${threshold})`);
      } else {
        activeStrategy = "spot";
        log("deploy", `Dynamic strategy: resolved to 'spot' (volatility ${normalizedVolatility.toFixed(4)} < threshold ${threshold})`);
      }
    } else {
      activeStrategy = "spot";
      log("deploy", `Dynamic strategy: volatility not available; resolved to fallback 'spot'`);
    }
  }

  if (process.env.DRY_RUN !== "true" && isPoolOnCooldown(pool_address)) {
    log("deploy", `Pool ${pool_address.slice(0, 8)} is on cooldown — skipping`);
    return { success: false, error: "Pool on cooldown — was recently closed with a cooldown reason. Try a different pool." };
  }

  const { StrategyType, getBinIdFromPrice, getPriceOfBinByBinId } = await getDLMM();
  const pool = await getPool(pool_address);
  const baseMint = pool.lbPair.tokenXMint.toString();
  if (process.env.DRY_RUN !== "true" && isBaseMintOnCooldown(baseMint)) {
    log("deploy", `Base mint ${baseMint.slice(0, 8)} is on cooldown — skipping deploy for pool ${pool_address.slice(0, 8)}`);
    return { success: false, error: "Token on cooldown — recently closed out-of-range too many times. Try a different token." };
  }
  const activeBin = await pool.getActiveBin();
  const actualBinStep = pool.lbPair.binStep;
  const activePrice = Number(getPriceOfBinByBinId(activeBin.binId, actualBinStep).toString());

  if (downside_pct != null || upside_pct != null) {
    const downsidePct = Math.max(0, Number(downside_pct ?? 0));
    const upsidePct = Math.max(0, Number(upside_pct ?? 0));

    if (!Number.isFinite(downsidePct) || !Number.isFinite(upsidePct)) {
      throw new Error("downside_pct and upside_pct must be valid numbers.");
    }
    if (downsidePct >= 100) {
      throw new Error("downside_pct must be less than 100.");
    }

    const lowerTargetPrice = activePrice * (1 - downsidePct / 100);
    const upperTargetPrice = activePrice * (1 + upsidePct / 100);
    const lowerBinId = getBinIdFromPrice(lowerTargetPrice, actualBinStep, true);
    const upperBinId = getBinIdFromPrice(upperTargetPrice, actualBinStep, false);

    activeBinsBelow = Math.max(0, activeBin.binId - lowerBinId);
    activeBinsAbove = Math.max(0, upperBinId - activeBin.binId);
  } else {
    if (activeBinsBelow == null) {
      if (config.strategy.targetDownsidePct != null) {
        const targetDownsidePct = Number(config.strategy.targetDownsidePct);
        if (targetDownsidePct < 100 && targetDownsidePct > 0) {
          const targetPrice = activePrice * (1 - targetDownsidePct / 100);
          const binsBelowCalculated = Math.ceil(
            Math.log(activePrice / targetPrice) / Math.log(1 + actualBinStep / 10000)
          );
          const configMin = config.strategy.minBinsBelow ?? 35;
          const configMax = config.strategy.maxBinsBelow ?? 69;
          activeBinsBelow = Math.max(configMin, Math.min(configMax, binsBelowCalculated));
          log("deploy", `Dynamic range scaling: target downside ${targetDownsidePct}% resolves to target price ${targetPrice.toFixed(6)} and requires ${binsBelowCalculated} bins (clamped bins_below: ${activeBinsBelow}, config: [${configMin}, ${configMax}])`);
        } else {
          activeBinsBelow = config.strategy.defaultBinsBelow ?? config.strategy.minBinsBelow;
        }
      } else {
        activeBinsBelow = config.strategy.defaultBinsBelow ?? config.strategy.minBinsBelow;
      }
    }
    activeBinsAbove = activeBinsAbove ?? 0;
  }

  // Calculate amounts
  // If no explicit SOL amount is provided, fall back to the configured dynamic deploy size.
  const fallbackAmountY =
    amount_y == null && amount_sol == null
      ? computeDeployAmount((await getWalletBalances()).sol)
      : 0;
  const finalAmountY = Number(amount_y ?? amount_sol ?? fallbackAmountY);
  const finalAmountX = Number(amount_x ?? 0);
  if (!Number.isFinite(finalAmountY) || !Number.isFinite(finalAmountX) || finalAmountY < 0 || finalAmountX < 0) {
    throw new Error("Invalid deploy amount: amount_x and amount_y must be valid non-negative numbers.");
  }
  if (finalAmountX > 0) {
    throw new Error("Unsupported deploy amount: this agent only supports single-side SOL deploys. Use amount_y/amount_sol and keep amount_x=0.");
  }
  if (finalAmountY <= 0) {
    throw new Error("Invalid deploy amount: provide a positive amount_y/amount_sol.");
  }
  const isSingleSidedSol = finalAmountX <= 0 && finalAmountY > 0;
  if (isSingleSidedSol && (Number(bins_above ?? 0) > 0 || Number(upside_pct ?? 0) > 0)) {
    throw new Error(
      "Single-side SOL deploy cannot use bins_above or upside_pct. Use amount_y with bins_below only; the upper bin is the SDK active bin.",
    );
  }
  if (isSingleSidedSol) {
    activeBinsAbove = 0;
  }
  activeBinsBelow = Number(activeBinsBelow);
  activeBinsAbove = Number(activeBinsAbove);
  if (!Number.isFinite(activeBinsBelow) || !Number.isFinite(activeBinsAbove)) {
    throw new Error("Invalid bin range: bins_below and bins_above must be valid numbers.");
  }
  if (activeBinsBelow < 0 || activeBinsAbove < 0) {
    throw new Error("Invalid bin range: bins_below and bins_above cannot be negative.");
  }
  if (!Number.isInteger(activeBinsBelow) || !Number.isInteger(activeBinsAbove)) {
    throw new Error("Invalid bin range: bins_below and bins_above must be whole-bin integers.");
  }
  const minBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Number(config.strategy.minBinsBelow ?? MIN_SAFE_BINS_BELOW));
  const totalBins = activeBinsBelow + activeBinsAbove;
  if (totalBins < minBinsBelow) {
    throw new Error(
      `Invalid deploy range: total bins ${totalBins} is below minimum ${minBinsBelow}. Refusing 1-bin/tiny-range deploy.`,
    );
  }

  const strategyMap = {
    spot: StrategyType.Spot,
    curve: StrategyType.Curve,
    bid_ask: StrategyType.BidAsk,
    bidask: StrategyType.BidAsk, // shape-param alias (no underscore)
  };

  let strategyType = strategyMap[activeStrategy];
  if (strategyType === undefined) {
    throw new Error(`Invalid strategy: ${activeStrategy}. Use spot, curve, or bid_ask.`);
  }

  // ── Bin-distribution SHAPE override (optional, LLM-choosable) ──────────
  // `shape` selects the intra-range liquidity curve independently of the range
  // WIDTH (bins) and of the legacy `strategy` field. It is OPT-IN: when omitted
  // the strategyType above (derived from `strategy`) is used verbatim, so the
  // default deploy path is byte-identical to before. Only when a shape is
  // explicitly requested do we consult config.strategy.defaultShape as its
  // fallback and remap strategyType. The resolved shape then becomes the
  // recorded `strategy` string so closed-position analytics can segment by it.
  //   spot   → Spot   (uniform, today's default)
  //   curve  → Curve  (concentrated near the active bin — max fees in-range)
  //   bidask → BidAsk (weighted to the range edges — dip-accumulator below)
  if (shape != null) {
    const resolvedShape = String(shape ?? config.strategy.defaultShape ?? "spot").toLowerCase();
    const shapeType = strategyMap[resolvedShape];
    if (shapeType === undefined) {
      throw new Error(`Invalid shape: ${shape}. Use spot, curve, or bidask.`);
    }
    strategyType = shapeType;
    activeStrategy = resolvedShape; // flows to trackPosition → recordPerformance for analytics
    log("deploy", `Bin-distribution shape override: '${resolvedShape}' (StrategyType.${StrategyType[shapeType]})`);
  }

  if (process.env.DRY_RUN === "true") {
    return {
      dry_run: true,
      would_deploy: {
        pool_address,
        strategy: activeStrategy,
        shape: shape != null ? activeStrategy : null,
        strategy_type: StrategyType[strategyType],
        bins_below: activeBinsBelow,
        bins_above: activeBinsAbove,
        downside_pct: downside_pct ?? null,
        upside_pct: upside_pct ?? null,
        amount_x: finalAmountX,
        amount_y: finalAmountY,
        wide_range: totalBins > 69,
      },
      message: "DRY RUN — no transaction sent",
    };
  }

  const isWideRange = totalBins > 69;
  const minBinId = activeBin.binId - activeBinsBelow;
  const maxBinId = isSingleSidedSol ? activeBin.binId : activeBin.binId + activeBinsAbove;

  if (minBinId > maxBinId) {
    throw new Error(`Invalid bin range: ${minBinId} -> ${maxBinId}`);
  }
  if (isSingleSidedSol && maxBinId !== activeBin.binId) {
    throw new Error(
      `Single-side SOL deploy must end at the SDK active bin. Expected ${activeBin.binId}, got ${maxBinId}.`,
    );
  }

  await assertRangeDoesNotRequireBinArrayInitialization(pool, minBinId, maxBinId);

  const minPrice = Number(getPriceOfBinByBinId(minBinId, actualBinStep).toString());
  const maxPrice = Number(getPriceOfBinByBinId(maxBinId, actualBinStep).toString());
  const downsideCoveragePct = activePrice > 0 ? ((activePrice - minPrice) / activePrice) * 100 : null;
  const upsideCoveragePct = activePrice > 0 ? ((maxPrice - activePrice) / activePrice) * 100 : null;
  const totalWidthPct = minPrice > 0 ? ((maxPrice - minPrice) / minPrice) * 100 : null;

  // Read base fee directly from pool — baseFactor * binStep / 10^6 gives fee in %
  const baseFactor = pool.lbPair.parameters?.baseFactor ?? 0;
  const actualBaseFee = base_fee ?? (baseFactor > 0 ? parseFloat((baseFactor * actualBinStep / 1e6 * 100).toFixed(4)) : null);

  const totalYLamports = new BN(Math.floor(finalAmountY * 1e9));
  // For X, we assume it's also 9 decimals for now, or we'd need to fetch mint decimals.
  // Most Meteora pools base tokens are 6 or 9. To be safe, we should fetch.
  let totalXLamports = new BN(0);
  if (finalAmountX > 0) {
    const mintInfo = await getConnection().getParsedAccountInfo(new PublicKey(pool.lbPair.tokenXMint));
    const decimals = mintInfo.value?.data?.parsed?.info?.decimals ?? 9;
    totalXLamports = new BN(Math.floor(finalAmountX * Math.pow(10, decimals)));
  }

  if (shouldUseLpAgentRelayForDeploy()) {
    try {
      const wallet = getWallet();
      log(
        "deploy",
        `Relay deploy via Agent Meridian: ${pool_address} activeBin ${activeBin.binId} bins ${minBinId}->${maxBinId} amountY=${finalAmountY}`,
      );
      const order = await meridianJson("/execution/zap-in/order", {
        method: "POST",
        headers: getMeridianHeaders(),
        body: JSON.stringify({
          agentId: config.hiveMind.agentId || "agent-local",
          idempotencyKey: `deploy:${pool_address}:${minBinId}:${maxBinId}:${finalAmountY}:${finalAmountX}`,
          poolId: pool_address,
          owner: wallet.publicKey.toString(),
          strategy: activeStrategy === "spot" ? "Spot" : "BidAsk",
          inputSOL: finalAmountY,
          amountY: finalAmountY,
          amountX: finalAmountX,
          percentX: finalAmountX > 0 && finalAmountY > 0 ? 0.5 : 0,
          fromBinId: minBinId,
          toBinId: maxBinId,
          slippageBps: 500,
          provider: "JUPITER_ULTRA",
        }),
      });

      const addLiquidityUnsigned = order?.order?.transactions?.addLiquidity || [];
      const swapUnsigned = order?.order?.transactions?.swap || [];
      if (addLiquidityUnsigned.length + swapUnsigned.length === 0) {
        throw new Error("LPAgent order returned no transactions. Check the pool address, deploy amount, and selected range.");
      }
      assertNoInitializeBinArrayInstructions(addLiquidityUnsigned);

      const addLiquidity = signSerializedTransactions(addLiquidityUnsigned, wallet);
      const swap = signSerializedTransactions(swapUnsigned, wallet);
      const submit = await meridianJson("/execution/zap-in/submit", {
        method: "POST",
        headers: getMeridianHeaders(),
        body: JSON.stringify({
          requestId: order.requestId,
          lastValidBlockHeight: order?.order?.lastValidBlockHeight,
          transactions: {
            addLiquidity,
            swap,
          },
          meta: {
            pool: pool_address,
            strategy: activeStrategy,
          },
        }),
      });

      await new Promise((resolve) => setTimeout(resolve, 5000));
      _positionsCacheAt = 0;
      const refreshed = await getMyPositions({ force: true, silent: true }).catch(() => null);
      const matching = refreshed?.positions?.find(
        (position) => position.pool === pool_address && position.lower_bin === minBinId && position.upper_bin === maxBinId,
      ) || refreshed?.positions?.find((position) => position.pool === pool_address);

      const positionAddress = matching?.position || null;
      if (positionAddress) {
        const signalSnapshot = config.darwin?.enabled
          ? getAndClearStagedSignals(pool_address, baseMint)
          : null;
        // initial_value_usd from the caller is only an LLM/heuristic ESTIMATE
        // (tool schema: "Estimated USD value being deployed") and is routinely
        // wrong by ~2x — it made the dashboard "Value" column read e.g.
        // "$34 of $58.80". Prefer the position's ACTUAL just-deployed value in
        // real USD (buildPosition's total_value_true_usd), falling back to the
        // estimate only if the on-chain read is unavailable.
        const initialValueUsdFinal =
          matching?.total_value_true_usd ?? initial_value_usd ?? null;
        trackPosition({
          position: positionAddress,
          pool: pool_address,
          pool_name,
          strategy: activeStrategy,
          bin_range: {
            min: matching?.lower_bin ?? minBinId,
            max: matching?.upper_bin ?? maxBinId,
            bins_below: activeBinsBelow,
            bins_above: activeBinsAbove
          },
          bin_step,
          volatility: normalizedVolatility,
          fee_tvl_ratio,
          organic_score,
          amount_sol: finalAmountY,
          amount_x: finalAmountX,
          active_bin: activeBin.binId,
          initial_value_usd: initialValueUsdFinal,
          signal_snapshot: signalSnapshot,
          entry_mcap,
          entry_tvl,
          entry_volume,
          entry_holders,
          fee_efficiency: getFeeEfficiencyForPool(pool_address),
          organic_momentum: getOrganicMomentumForPool(pool_address),
          token_age_hours: signalSnapshot?.token_age_hours ?? null,
          lazy,
        });
      }

      const intel_score = (signalSnapshot?.intel_total != null) ? {
        total: signalSnapshot.intel_total,
        safety: signalSnapshot.intel_safety,
        yield: signalSnapshot.intel_yield,
        momentum: signalSnapshot.intel_momentum,
        trust: signalSnapshot.intel_trust,
      } : null;

      appendDecision({
        type: "deploy",
        actor: "SCREENER",
        pool: pool_address,
        pool_name,
        position: positionAddress,
        intel_score,
        summary: `Relay deployed ${finalAmountY} SOL with ${activeStrategy}`,
        reason: `Chosen range ${minBinId}→${maxBinId} around active bin ${activeBin.binId}`,
        risks: [
          normalizedVolatility != null ? `volatility ${normalizedVolatility}` : null,
          fee_tvl_ratio != null ? `fee/TVL ${fee_tvl_ratio}%` : null,
        ].filter(Boolean),
        metrics: {
          amount_sol: finalAmountY,
          strategy: activeStrategy,
          active_bin: activeBin.binId,
          min_bin: minBinId,
          max_bin: maxBinId,
          downside_pct: downside_pct ?? downsideCoveragePct,
          upside_pct: upside_pct ?? upsideCoveragePct,
        },
      });

      return {
        success: true,
        relay: true,
        request_id: order.requestId,
        position: positionAddress,
        pool: pool_address,
        pool_name,
        bin_range: { min: minBinId, max: maxBinId, active: activeBin.binId },
        price_range: { min: minPrice, max: maxPrice },
        range_coverage: {
          downside_pct: downsideCoveragePct,
          upside_pct: upsideCoveragePct,
          width_pct: totalWidthPct,
          active_price: activePrice,
        },
        bin_step: actualBinStep,
        base_fee: actualBaseFee,
        strategy: activeStrategy,
        wide_range: isWideRange,
        amount_x: finalAmountX,
        amount_y: finalAmountY,
        txs: normalizeExecutionSignatures(submit),
      };
    } catch (error) {
      log("deploy_error", `Relay deploy failed: ${error.message}`);
      // A "failed" relay submit can still land the liquidity (partial-bundle
      // success). Verify on-chain before discarding the position.
      const recovered = await recoverLandedDeploy({
        pool_address,
        minBinId,
        maxBinId,
        extra: {
          pool_name,
          base_mint: baseMint,
          strategy: activeStrategy,
          bins_below: activeBinsBelow,
          bins_above: activeBinsAbove,
          bin_step,
          volatility: normalizedVolatility,
          fee_tvl_ratio,
          organic_score,
          amount_sol: finalAmountY,
          amount_x: finalAmountX,
          active_bin: activeBin.binId,
          entry_mcap,
          entry_tvl,
          entry_volume,
          entry_holders,
        },
      });
      if (recovered) {
        return {
          success: true,
          recovered_after_error: true,
          error: error.message,
          relay: true,
          position: recovered.position,
          pool: pool_address,
          pool_name,
          bin_range: { min: minBinId, max: maxBinId, active: activeBin.binId },
          strategy: activeStrategy,
          amount_x: finalAmountX,
          amount_y: finalAmountY,
          note: "Deploy reported failure but the position landed on-chain — adopted into state.",
        };
      }
      return { success: false, error: error.message };
    }
  }

  const wallet = getWallet();
  const newPosition = Keypair.generate();

  log("deploy", `Pool: ${pool_address}`);
  log("deploy", `Strategy: ${activeStrategy}, Bins: ${minBinId} to ${maxBinId} (${totalBins} bins${isWideRange ? " — WIDE RANGE" : ""})`);
  log("deploy", `Amount: ${finalAmountX} X, ${finalAmountY} Y`);
  log("deploy", `Position: ${newPosition.publicKey.toString()}`);

  try {
    const txHashes = [];
    let totalGasLamports = 0;

    if (isWideRange) {
      // ── Wide Range Path (>69 bins) ─────────────────────────────────
      // Solana limits inner instruction realloc to 10240 bytes, so we can't create
      // a large position in a single initializePosition ix.
      // Solution: createExtendedEmptyPosition (returns Transaction | Transaction[]),
      //           then addLiquidityByStrategyChunkable (returns Transaction[]).

      // Phase 1: Create empty position (may be multiple txs)
      const createTxs = await pool.createExtendedEmptyPosition(
        minBinId,
        maxBinId,
        newPosition.publicKey,
        wallet.publicKey,
      );
      const createTxArray = Array.isArray(createTxs) ? createTxs : [createTxs];
      for (let i = 0; i < createTxArray.length; i++) {
        const signers = i === 0 ? [wallet, newPosition] : [wallet];
        const { txHash, fee } = await sendAndConfirmWithRetry(getConnection(), createTxArray[i], signers, "deploy:create");
        txHashes.push(txHash);
        totalGasLamports += fee;
        log("deploy", `Create tx ${i + 1}/${createTxArray.length}: ${txHash}`);
      }

      // Phase 2: Add liquidity (may be multiple txs)
      // If this fails, we must clean up the empty position from Phase 1
      // to avoid a ghost position that blocks a slot and locks rent.
      try {
        const addTxs = await pool.addLiquidityByStrategyChunkable({
          positionPubKey: newPosition.publicKey,
          user: wallet.publicKey,
          totalXAmount: totalXLamports,
          totalYAmount: totalYLamports,
          strategy: { minBinId, maxBinId, strategyType },
          slippage: 10, // 10%
        });
        const addTxArray = Array.isArray(addTxs) ? addTxs : [addTxs];
        for (let i = 0; i < addTxArray.length; i++) {
          const { txHash, fee } = await sendAndConfirmWithRetry(getConnection(), addTxArray[i], [wallet], "deploy:addLiquidity");
          txHashes.push(txHash);
          totalGasLamports += fee;
          log("deploy", `Add liquidity tx ${i + 1}/${addTxArray.length}: ${txHash}`);
        }
      } catch (addLiqErr) {
        log("deploy_error", `Add liquidity failed after position created — cleaning up empty position ${newPosition.publicKey.toString()}`);
        try {
          const removeTx = await pool.closePosition({
            owner: wallet.publicKey,
            position: { publicKey: newPosition.publicKey },
          });
          const removeTxArray = Array.isArray(removeTx) ? removeTx : [removeTx];
          for (const tx of removeTxArray) {
            const { fee: cleanupFee } = await sendAndConfirmWithRetry(getConnection(), tx, [wallet], "deploy:cleanup");
            totalGasLamports += cleanupFee;
          }
          log("deploy", `Cleaned up empty position ${newPosition.publicKey.toString()} — rent recovered`);
        } catch (cleanupErr) {
          log("deploy_error", `Failed to clean up empty position ${newPosition.publicKey.toString()}: ${cleanupErr.message}`);
        }
        throw addLiqErr; // Re-throw so the deploy is reported as failed
      }
    } else {
      // ── Standard Path (≤69 bins) ─────────────────────────────────
      const tx = await pool.initializePositionAndAddLiquidityByStrategy({
        positionPubKey: newPosition.publicKey,
        user: wallet.publicKey,
        totalXAmount: totalXLamports,
        totalYAmount: totalYLamports,
        strategy: { maxBinId, minBinId, strategyType },
        slippage: 1000, // 10% in bps
      });
      const { txHash, fee } = await sendAndConfirmWithRetry(getConnection(), tx, [wallet, newPosition], "deploy:initAndAdd");
      txHashes.push(txHash);
      totalGasLamports += fee;
    }

    const deploy_gas_sol = totalGasLamports / 1e9;
    log("deploy", `SUCCESS — ${txHashes.length} tx(s): ${txHashes[0]} | gas: ${deploy_gas_sol.toFixed(6)} SOL`);

    _positionsCacheAt = 0;
    const signalSnapshot = config.darwin?.enabled
      ? getAndClearStagedSignals(pool_address, baseMint)
      : null;
    // The caller's initial_value_usd is only an LLM/heuristic ESTIMATE and is
    // routinely ~2x off (drove the dashboard "$34 of $58.80" Value bug). This
    // path knows the position address up-front (no post-deploy refresh), so
    // derive the real USD value deterministically from the SOL just deployed —
    // deploys are single-side SOL, so amount_sol × live SOL price is accurate.
    const solPriceNow = getSolPriceUsd();
    const initialValueUsdFinal =
      solPriceNow > 0 ? finalAmountY * solPriceNow : (initial_value_usd ?? null);
    trackPosition({
      position: newPosition.publicKey.toString(),
      pool: pool_address,
      pool_name,
      strategy: activeStrategy,
      bin_range: { min: minBinId, max: maxBinId, bins_below: activeBinsBelow, bins_above: activeBinsAbove },
      bin_step,
      volatility: normalizedVolatility,
      fee_tvl_ratio,
      organic_score,
      amount_sol: finalAmountY,
      amount_x: finalAmountX,
      active_bin: activeBin.binId,
      initial_value_usd: initialValueUsdFinal,
      signal_snapshot: signalSnapshot,
      entry_mcap,
      entry_tvl,
      entry_volume,
      entry_holders,
      fee_efficiency: getFeeEfficiencyForPool(pool_address),
      organic_momentum: getOrganicMomentumForPool(pool_address),
      token_age_hours: signalSnapshot?.token_age_hours ?? null,
      lazy,
      gas_cost_sol: deploy_gas_sol,
    });

    const intel_score = (signalSnapshot?.intel_total != null) ? {
      total: signalSnapshot.intel_total,
      safety: signalSnapshot.intel_safety,
      yield: signalSnapshot.intel_yield,
      momentum: signalSnapshot.intel_momentum,
      trust: signalSnapshot.intel_trust,
    } : null;

    appendDecision({
      type: "deploy",
      actor: "SCREENER",
      pool: pool_address,
      pool_name,
      position: newPosition.publicKey.toString(),
      intel_score,
      summary: `Deployed ${finalAmountY} SOL with ${activeStrategy}`,
      reason: `Chosen range ${minBinId}→${maxBinId} around active bin ${activeBin.binId}`,
      risks: [
        normalizedVolatility != null ? `volatility ${normalizedVolatility}` : null,
        fee_tvl_ratio != null ? `fee/TVL ${fee_tvl_ratio}%` : null,
      ].filter(Boolean),
      metrics: {
        amount_sol: finalAmountY,
        strategy: activeStrategy,
        active_bin: activeBin.binId,
        min_bin: minBinId,
        max_bin: maxBinId,
        downside_pct: downside_pct ?? null,
        upside_pct: upside_pct ?? null,
        gas_cost_sol: deploy_gas_sol,
      },
    });

    return {
      success: true,
      position: newPosition.publicKey.toString(),
      pool: pool_address,
      pool_name,
      bin_range: { min: minBinId, max: maxBinId, active: activeBin.binId },
      price_range: { min: minPrice, max: maxPrice },
      range_coverage: {
        downside_pct: downsideCoveragePct,
        upside_pct: upsideCoveragePct,
        width_pct: totalWidthPct,
        active_price: activePrice,
      },
      bin_step: actualBinStep,
      base_fee: actualBaseFee,
      strategy: activeStrategy,
      wide_range: isWideRange,
      amount_x: finalAmountX,
      amount_y: finalAmountY,
      txs: txHashes,
      gas_cost_sol: deploy_gas_sol,
    };
  } catch (error) {
    log("deploy_error", error.message);
    // The position keypair is known here, so a "failed" deploy that actually
    // minted the position (e.g. confirm timeout after landing, or a partial
    // multi-tx wide-range deploy) can be verified precisely by pubkey and
    // adopted rather than orphaned.
    const recovered = await recoverLandedDeploy({
      positionPubkey: newPosition.publicKey.toString(),
      pool_address,
      minBinId,
      maxBinId,
      extra: {
        pool_name,
        base_mint: baseMint,
        strategy: activeStrategy,
        bins_below: activeBinsBelow,
        bins_above: activeBinsAbove,
        bin_step,
        volatility: normalizedVolatility,
        fee_tvl_ratio,
        organic_score,
        amount_sol: finalAmountY,
        amount_x: finalAmountX,
        active_bin: activeBin.binId,
        entry_mcap,
        entry_tvl,
        entry_volume,
        entry_holders,
      },
    });
    if (recovered) {
      return {
        success: true,
        recovered_after_error: true,
        error: error.message,
        position: recovered.position,
        pool: pool_address,
        pool_name,
        bin_range: { min: minBinId, max: maxBinId, active: activeBin.binId },
        bin_step: actualBinStep,
        base_fee: actualBaseFee,
        strategy: activeStrategy,
        wide_range: isWideRange,
        amount_x: finalAmountX,
        amount_y: finalAmountY,
        note: "Deploy reported failure but the position landed on-chain — adopted into state.",
      };
    }
    return { success: false, error: error.message };
  }
}

const POSITIONS_CACHE_TTL = 5 * 60_000; // 5 minutes

let _positionsCache = null;
let _positionsCacheAt = 0;
let _positionsInflight = null; // deduplicates concurrent calls
const LPAGENT_API = "https://api.lpagent.io/open-api/v1";

async function fetchLpAgentOpenPositions(walletAddress) {
  if (!process.env.LPAGENT_API_KEY) return {};

  const url = `${LPAGENT_API}/lp-positions/opening?owner=${walletAddress}`;
  try {
    const res = await fetch(url, {
      headers: {
        "x-api-key": process.env.LPAGENT_API_KEY,
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      log("lpagent_api", `HTTP ${res.status} for owner ${walletAddress.slice(0, 8)}: ${body.slice(0, 160)}`);
      return {};
    }
    const data = await res.json();
    const positions = data?.data || [];
    const byAddress = {};
    for (const p of positions) {
      const addr = p.position || p.id || p.tokenId;
      if (addr) byAddress[addr] = p;
    }
    return byAddress;
  } catch (e) {
    log("lpagent_api", `Fetch error for owner ${walletAddress.slice(0, 8)}: ${e.message}`);
    return {};
  }
}

// ─── Get Position PnL (Meteora API) ─────────────────────────────
export async function getPositionPnl({ pool_address, position_address }) {
  await ensureStateInitialized();
  pool_address = normalizeMint(pool_address);
  position_address = normalizeMint(position_address);
  const walletAddress = getWallet().publicKey.toString();
  // Prefer the public-infra path (RPC + Jupiter + Meteora deposits) used by getMyPositions.
  if (config.pnl.source === "rpc") {
    try {
      const payload = await getMyPositions({ force: true, silent: true });
      const p = payload?.positions?.find((position) => position.position === position_address);
      if (p) {
        return {
          pnl_usd: p.pnl_usd,
          pnl_pct: p.pnl_pct,
          current_value_usd: p.total_value_usd,
          unclaimed_fee_usd: p.unclaimed_fees_usd,
          all_time_fees_usd: p.collected_fees_usd,
          fee_per_tvl_24h: p.fee_per_tvl_24h,
          in_range: p.in_range,
          lower_bin: p.lower_bin,
          upper_bin: p.upper_bin,
          active_bin: p.active_bin,
          age_minutes: p.age_minutes,
        };
      }
    } catch (error) {
      log("pnl_warn", `RPC PnL lookup failed; falling back to direct Meteora PnL path: ${error.message}`);
    }
  }
  try {
    const byAddress = await fetchDlmmPnlForPool(pool_address, walletAddress);
    const p = byAddress[position_address];
    if (!p) return { error: "Position not found in PnL API" };

    const solMode = config.management.solMode;
    const unclaimedValue = solMode
      ? safeNum(p.unrealizedPnl?.unclaimedFeeTokenX?.amountSol) + safeNum(p.unrealizedPnl?.unclaimedFeeTokenY?.amountSol)
      : safeNum(p.unrealizedPnl?.unclaimedFeeTokenX?.usd) + safeNum(p.unrealizedPnl?.unclaimedFeeTokenY?.usd);
    const currentValue = solMode
      ? safeNum(p.unrealizedPnl?.balancesSol)
      : safeNum(p.unrealizedPnl?.balances);
    const reportedPnlPct = solMode
      ? maybeNum(p.pnlSolPctChange)
      : maybeNum(p.pnlPctChange);
    const derivedPnlPct = deriveOpenPnlPct(p, solMode);
    return {
      pnl_usd:           roundNum(solMode ? p.pnlSol : p.pnlUsd, 4),
      pnl_pct:           roundNum(reportedPnlPct ?? derivedPnlPct ?? 0, 2),
      current_value_usd: roundNum(currentValue, 4),
      unclaimed_fee_usd: roundNum(unclaimedValue, 4),
      all_time_fees_usd: roundNum(solMode ? p.allTimeFees?.total?.sol : p.allTimeFees?.total?.usd, 4),
      fee_per_tvl_24h:   Math.round(parseFloat(p.feePerTvl24h || 0) * 100) / 100,
      in_range:    !p.isOutOfRange,
      lower_bin:   p.lowerBinId      ?? null,
      upper_bin:   p.upperBinId      ?? null,
      active_bin:  p.poolActiveBinId ?? null,
      age_minutes: p.createdAt ? Math.floor((Date.now() - p.createdAt * 1000) / 60000) : null,
    };
  } catch (error) {
    log("pnl_error", error.message);
    return { error: error.message };
  }
}

function safeNum(value) {
  const n = parseFloat(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function maybeNum(value) {
  if (value == null || value === "") return null;
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

function roundNum(value, decimals = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

const PERFORMANCE_SIGNAL_FIELDS = [
  "organic_score",
  "fee_tvl_ratio",
  "volume",
  "mcap",
  "holder_count",
  "smart_wallets_present",
  "narrative_quality",
  "study_win_rate",
  "hive_consensus",
  "volatility",
];

function resolvePerformanceSignalSnapshot({ poolAddress, baseMint, tracked }) {
  const staged = config.darwin?.enabled
    ? getAndClearStagedSignals(poolAddress, baseMint)
    : null;
  const snapshot = {
    ...(staged || {}),
    ...(tracked?.signal_snapshot || {}),
  };

  if (baseMint && snapshot.base_mint == null) snapshot.base_mint = baseMint;
  for (const field of PERFORMANCE_SIGNAL_FIELDS) {
    if (snapshot[field] == null && tracked?.[field] != null) {
      snapshot[field] = tracked[field];
    }
  }

  return Object.values(snapshot).some((value) => value != null) ? snapshot : null;
}

function getClosedPnlValue(posEntry, solMode = false) {
  return solMode
    ? maybeNum(posEntry?.pnlSol) ?? maybeNum(posEntry?.pnl?.valueNative) ?? 0
    : maybeNum(posEntry?.pnlUsd) ?? maybeNum(posEntry?.pnl?.value) ?? 0;
}

function getClosedPnlPct(posEntry, solMode = false) {
  const reported = solMode
    ? maybeNum(posEntry?.pnlSolPctChange) ?? maybeNum(posEntry?.pnl?.percentNative)
    : maybeNum(posEntry?.pnlPctChange) ?? maybeNum(posEntry?.pnl?.percent);
  if (reported != null) return reported;

  const pnl = getClosedPnlValue(posEntry, solMode);
  const deposit = solMode
    ? maybeNum(posEntry?.allTimeDeposits?.total?.sol)
    : maybeNum(posEntry?.allTimeDeposits?.total?.usd);
  return deposit && deposit > 0 ? (pnl / deposit) * 100 : 0;
}

function deriveOpenPnlPct(binData, solMode = false) {
  if (!binData) return null;

  const deposit = solMode
    ? safeNum(binData.allTimeDeposits?.total?.sol)
    : safeNum(binData.allTimeDeposits?.total?.usd);
  if (deposit <= 0) return null;

  const balances = solMode
    ? safeNum(binData.unrealizedPnl?.balancesSol)
    : safeNum(binData.unrealizedPnl?.balances);
  const unclaimedFees = solMode
    ? safeNum(binData.unrealizedPnl?.unclaimedFeeTokenX?.amountSol) + safeNum(binData.unrealizedPnl?.unclaimedFeeTokenY?.amountSol)
    : safeNum(binData.unrealizedPnl?.unclaimedFeeTokenX?.usd) + safeNum(binData.unrealizedPnl?.unclaimedFeeTokenY?.usd);
  const withdrawals = solMode
    ? safeNum(binData.allTimeWithdrawals?.total?.sol)
    : safeNum(binData.allTimeWithdrawals?.total?.usd);
  const fees = solMode
    ? safeNum(binData.allTimeFees?.total?.sol)
    : safeNum(binData.allTimeFees?.total?.usd);

  const pnl = balances + unclaimedFees + withdrawals + fees - deposit;
  return (pnl / deposit) * 100;
}

function deriveLpAgentPnlPct(lpData, solMode = false) {
  if (!lpData) return null;
  const deposit = solMode ? safeNum(lpData.inputNative) : safeNum(lpData.inputValue);
  if (deposit <= 0) return null;

  const currentValue = solMode ? safeNum(lpData.valueNative) : safeNum(lpData.value);
  const unclaimedFees = solMode ? safeNum(lpData.unCollectedFeeNative) : safeNum(lpData.unCollectedFee);
  const pnl = currentValue + unclaimedFees - deposit;
  return (pnl / deposit) * 100;
}

async function fetchRawOpenPositionsFromMeridian({ walletAddress, agentId }) {
  const search = new URLSearchParams({
    owner: walletAddress,
    agentId: agentId || "agent-local",
  });
  const payload = await meridianJson(`/positions/open/raw?${search.toString()}`, {
    headers: config.api.publicApiKey ? { "x-api-key": config.api.publicApiKey } : {},
    retry: {
      maxElapsedMs: 30_000,
      perAttemptTimeoutMs: 30_000,
    },
  });
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const byPosition = {};
  for (const row of rows) {
    const addr = row?.position || row?.id || row?.tokenId;
    if (addr) byPosition[addr] = row;
  }
  return {
    ...payload,
    data: rows,
    byPosition,
  };
}

// ─── Get My Positions ──────────────────────────────────────────
export async function getMyPositions({ force = false, silent = false, wallet_address = null } = {}) {
  await ensureStateInitialized();
  let walletOverride = null;
  try {
    walletOverride = wallet_address ? new PublicKey(wallet_address).toString() : null;
  } catch {
    return { wallet: wallet_address || null, total_positions: 0, positions: [], error: "Invalid wallet address" };
  }

  const useLocalWallet = !walletOverride;
  if (useLocalWallet && !force && _positionsCache && Date.now() - _positionsCacheAt < POSITIONS_CACHE_TTL) {
    return _positionsCache;
  }
  if (useLocalWallet && _positionsInflight) return _positionsInflight;

  let walletAddress;
  try {
    walletAddress = walletOverride || getWallet().publicKey.toString();
  } catch {
    return { wallet: null, total_positions: 0, positions: [], error: "Wallet not configured" };
  }

  const loadPositions = async () => { try {
    // ── Primary path: public infra (on-chain RPC + Jupiter + Meteora deposits) ──
    // No LPAgent / agentmeridian dependency, so the poller runs aggressively on
    // fully public resources. Falls through to the Meteora-API path on any error.
    if (config.pnl.source === "rpc") {
      try {
        if (!silent) log("positions", `Computing PnL from RPC (${maskUrl(config.pnl.rpcUrl)})...`);
        const rpcResult = await computePositions(walletAddress);
        if (useLocalWallet) {
          syncOpenPositions(rpcResult.positions.map((p) => p.position));
          _positionsCache = rpcResult;
          _positionsCacheAt = Date.now();
        }
        return rpcResult;
      } catch (error) {
        log("positions_warn", `RPC PnL path failed; falling back to Meteora portfolio API: ${error.message}`);
      }
    }

    // ── Fallback path: Meteora portfolio + /pnl APIs (no LPAgent) ──
    if (!silent) log("positions", "Fetching portfolio via Meteora portfolio API...");
    const portfolioUrl = `https://dlmm.datapi.meteora.ag/portfolio/open?user=${walletAddress}`;
    const res = await fetch(portfolioUrl);
    if (!res.ok) throw new Error(`Portfolio API ${res.status}: ${await res.text().catch(() => "")}`);
    const portfolio = await res.json();

    const pools = portfolio.pools || [];
    log("positions", `Found ${pools.length} pool(s) with open positions`);

    // Fetch bin data (lowerBinId, upperBinId, poolActiveBinId) for all pools in parallel
    // Needed for rules 3 & 4 (active_bin vs upper_bin comparison)
    const binDataByPool = {};
    const pnlMaps = await Promise.all(pools.map(pool => fetchDlmmPnlForPool(pool.poolAddress, walletAddress)));
    pools.forEach((pool, i) => { binDataByPool[pool.poolAddress] = pnlMaps[i]; });
    const lpAgentByPosition = {}; // LPAgent removed — Meteora binData only

    const positions = [];
    for (const pool of pools) {
      for (const positionAddress of (pool.listPositions || [])) {
        const tracked = getTrackedPosition(positionAddress);
        const isOOR = pool.outOfRange || pool.positionsOutOfRange?.includes(positionAddress);

        if (isOOR) markOutOfRange(positionAddress);
        else markInRange(positionAddress);

        // Bin data: from supplemental PnL call (OOR) or tracked state (in-range)
        const binData = binDataByPool[pool.poolAddress]?.[positionAddress];
        if (!binData) {
          log("positions_warn", `PnL API missing data for ${positionAddress.slice(0, 8)} in pool ${pool.poolAddress.slice(0, 8)} — using portfolio only for open-position discovery`);
        }
        const lowerBin  = binData?.lowerBinId      ?? tracked?.bin_range?.min ?? null;
        const upperBin  = binData?.upperBinId      ?? tracked?.bin_range?.max ?? null;
        const activeBin = binData?.poolActiveBinId ?? tracked?.bin_range?.active ?? null;
        const lpData = lpAgentByPosition[positionAddress] || null;

        const ageFromState = tracked?.deployed_at
          ? Math.floor((Date.now() - new Date(tracked.deployed_at).getTime()) / 60000)
          : null;
        const reportedPnlPct = lpData
          ? parseFloat(config.management.solMode ? (lpData.pnl?.percentNative || 0) : (lpData.pnl?.percent || 0))
          : binData
            ? parseFloat(config.management.solMode ? (binData.pnlSolPctChange || 0) : (binData.pnlPctChange || 0))
            : null;
        const derivedPnlPct = lpData
          ? deriveLpAgentPnlPct(lpData, config.management.solMode)
          : binData
            ? deriveOpenPnlPct(binData, config.management.solMode)
            : null;
        const pnlPctDiff = reportedPnlPct != null && derivedPnlPct != null
          ? Math.abs(reportedPnlPct - derivedPnlPct)
          : null;
        // Gate PnL rules ONLY when the tick is genuinely unpriceable (no real number
        // from either method — e.g. missing deposits / data outage). Reported-vs-derived
        // divergence is normal noise on volatile pools, so it is logged but NOT gated —
        // gating on it froze all exits (stop-loss/trailing/close) and stranded positions.
        const pnlPctSuspicious = reportedPnlPct == null && derivedPnlPct == null;
        if (pnlPctSuspicious) {
          log("positions_warn", `Unpriceable pnl_pct for ${positionAddress.slice(0, 8)}: no valid reported/derived value this tick — PnL rules paused`);
        } else if (pnlPctDiff != null && pnlPctDiff > (config.management.pnlSanityMaxDiffPct ?? 5)) {
          // Informational only — does not gate rules.
          log("positions_warn", `pnl_pct divergence for ${positionAddress.slice(0, 8)}: reported=${reportedPnlPct.toFixed(2)} derived=${derivedPnlPct.toFixed(2)} diff=${pnlPctDiff.toFixed(2)} (informational)`);
        }

        positions.push({
          position:           positionAddress,
          pool:               pool.poolAddress,
          pair:               tracked?.pool_name || `${pool.tokenX || getCachedSymbol(pool.tokenXMint) || (pool.tokenXMint ? `${String(pool.tokenXMint).slice(0, 4)}…` : "?")}/${pool.tokenY || "SOL"}`,
          base_mint:          pool.tokenXMint,
          lower_bin:          lowerBin,
          upper_bin:          upperBin,
          active_bin:         activeBin,
          in_range:           binData ? !binData.isOutOfRange : !isOOR,
          unclaimed_fees_usd: lpData
            ? Math.round((
                config.management.solMode
                  ? safeNum(lpData.unCollectedFeeNative)
                  : safeNum(lpData.unCollectedFee)
              ) * 10000) / 10000
            : binData
            ? Math.round((
                config.management.solMode
                  ? parseFloat(binData.unrealizedPnl?.unclaimedFeeTokenX?.amountSol || 0) + parseFloat(binData.unrealizedPnl?.unclaimedFeeTokenY?.amountSol || 0)
                  : parseFloat(binData.unrealizedPnl?.unclaimedFeeTokenX?.usd || 0) + parseFloat(binData.unrealizedPnl?.unclaimedFeeTokenY?.usd || 0)
              ) * 10000) / 10000
            : null,
          total_value_usd:    lpData
            ? Math.round((
                config.management.solMode
                  ? safeNum(lpData.valueNative)
                  : safeNum(lpData.value)
              ) * 10000) / 10000
            : binData
            ? Math.round((
                config.management.solMode
                  ? parseFloat(binData.unrealizedPnl?.balancesSol || 0)
                  : parseFloat(binData.unrealizedPnl?.balances || 0)
              ) * 10000) / 10000
            : null,
          // Always-USD fields for internal accounting and lesson recording.
          total_value_true_usd: lpData
            ? Math.round(safeNum(lpData.value) * 10000) / 10000
            : binData
            ? Math.round(parseFloat(binData.unrealizedPnl?.balances || 0) * 10000) / 10000
            : null,
          collected_fees_usd: lpData
            ? Math.round((
                config.management.solMode
                  ? safeNum(lpData.collectedFeeNative)
                  : safeNum(lpData.collectedFee)
              ) * 10000) / 10000
            : binData
            ? Math.round(parseFloat(config.management.solMode ? (binData.allTimeFees?.total?.sol || 0) : (binData.allTimeFees?.total?.usd || 0)) * 10000) / 10000
            : null,
          collected_fees_true_usd: lpData
            ? Math.round(safeNum(lpData.collectedFee) * 10000) / 10000
            : binData
            ? Math.round(parseFloat(binData.allTimeFees?.total?.usd || 0) * 10000) / 10000
            : null,
          pnl_usd:            lpData
            ? Math.round((
                config.management.solMode
                  ? safeNum(lpData.pnl?.valueNative)
                  : safeNum(lpData.pnl?.value)
              ) * 10000) / 10000
            : binData
            ? Math.round(parseFloat(config.management.solMode ? (binData.pnlSol || 0) : (binData.pnlUsd || 0)) * 10000) / 10000
            : null,
          pnl_true_usd:       lpData
            ? Math.round(safeNum(lpData.pnl?.value) * 10000) / 10000
            : binData
            ? Math.round(parseFloat(binData.pnlUsd || 0) * 10000) / 10000
            : null,
          pnl_pct:            (lpData || binData)
            ? Math.round(reportedPnlPct * 100) / 100
            : null,
          pnl_pct_usd:        binData ? Math.round(parseFloat(binData.pnlPctChange || 0) * 100) / 100 : null,
          pnl_pct_derived:    derivedPnlPct != null ? Math.round(derivedPnlPct * 100) / 100 : null,
          pnl_pct_diff:       pnlPctDiff != null ? Math.round(pnlPctDiff * 100) / 100 : null,
          pnl_pct_suspicious: !!pnlPctSuspicious,
          unclaimed_fees_true_usd: lpData
            ? Math.round(safeNum(lpData.unCollectedFee) * 10000) / 10000
            : binData
            ? Math.round((parseFloat(binData.unrealizedPnl?.unclaimedFeeTokenX?.usd || 0) + parseFloat(binData.unrealizedPnl?.unclaimedFeeTokenY?.usd || 0)) * 10000) / 10000
            : null,
          fee_per_tvl_24h:    binData
            ? Math.round(parseFloat(binData.feePerTvl24h || 0) * 100) / 100
            : null,
          age_minutes:        binData?.createdAt ? Math.floor((Date.now() - binData.createdAt * 1000) / 60000) : ageFromState,
          minutes_out_of_range: minutesOutOfRange(positionAddress),
          instruction:        tracked?.instruction ?? null,
        });
      }
    }

    const result = {
      wallet: walletAddress,
      total_positions: positions.length,
      positions,
      source: "meteora",
    };
    if (useLocalWallet) {
      syncOpenPositions(positions.map(p => p.position));
      _positionsCache = result;
      _positionsCacheAt = Date.now();
    }
    return result;
  } catch (error) {
    log("positions_error", `Portfolio fetch failed: ${error.stack || error.message}`);
    return { wallet: walletAddress, total_positions: 0, positions: [], error: error.message };
  } finally {
    if (useLocalWallet) _positionsInflight = null;
  }
  };

  if (useLocalWallet) {
    _positionsInflight = loadPositions();
    return _positionsInflight;
  }

  return loadPositions();
}

// ─── Get Positions for Any Wallet ─────────────────────────────
export async function getWalletPositions({ wallet_address }) {
  try {
    const DLMM_PROGRAM = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");

    const accounts = await getConnection().getProgramAccounts(DLMM_PROGRAM, {
      filters: [{ memcmp: { offset: 40, bytes: new PublicKey(wallet_address).toBase58() } }],
    });

    if (accounts.length === 0) {
      return { wallet: wallet_address, total_positions: 0, positions: [] };
    }

    const raw = accounts.map((acc) => ({
      position: acc.pubkey.toBase58(),
      pool: new PublicKey(acc.account.data.slice(8, 40)).toBase58(),
    }));

    // Enrich with PnL API
    const uniquePools = [...new Set(raw.map((r) => r.pool))];
    const pnlMaps = await Promise.all(uniquePools.map((pool) => fetchDlmmPnlForPool(pool, wallet_address)));
    const pnlByPool = {};
    uniquePools.forEach((pool, i) => { pnlByPool[pool] = pnlMaps[i]; });

    const positions = raw.map((r) => {
      const p = pnlByPool[r.pool]?.[r.position] || null;
      const solMode = config.management.solMode;
      const unclaimedValue = p
        ? solMode
          ? safeNum(p.unrealizedPnl?.unclaimedFeeTokenX?.amountSol) + safeNum(p.unrealizedPnl?.unclaimedFeeTokenY?.amountSol)
          : safeNum(p.unrealizedPnl?.unclaimedFeeTokenX?.usd) + safeNum(p.unrealizedPnl?.unclaimedFeeTokenY?.usd)
        : 0;
      const currentValue = p
        ? solMode
          ? safeNum(p.unrealizedPnl?.balancesSol)
          : safeNum(p.unrealizedPnl?.balances)
        : 0;
      const reportedPnlPct = p
        ? solMode
          ? maybeNum(p.pnlSolPctChange)
          : maybeNum(p.pnlPctChange)
        : null;
      const derivedPnlPct = p ? deriveOpenPnlPct(p, solMode) : null;

      const lowerBin  = p?.lowerBinId      ?? null;
      const upperBin  = p?.upperBinId      ?? null;
      const activeBin = p?.poolActiveBinId ?? null;
      // Prefer an authoritative active-bin-vs-bounds check when all three are
      // present; fall back to the API's isOutOfRange flag only when bounds are
      // missing (and to null when there is no position data at all).
      const inRange = (activeBin != null && lowerBin != null && upperBin != null)
        ? (activeBin >= lowerBin && activeBin <= upperBin)
        : (p ? !p.isOutOfRange : null);

      return {
        position:           r.position,
        pool:               r.pool,
        lower_bin:          lowerBin,
        upper_bin:          upperBin,
        active_bin:         activeBin,
        in_range:           inRange,
        unclaimed_fees_usd: roundNum(unclaimedValue, 4),
        total_value_usd:    roundNum(currentValue, 4),
        pnl_usd:            roundNum(p ? (solMode ? p.pnlSol : p.pnlUsd) : 0, 4),
        pnl_pct:            roundNum(reportedPnlPct ?? derivedPnlPct ?? 0, 2),
        age_minutes:        p?.createdAt ? Math.floor((Date.now() - p.createdAt * 1000) / 60000) : null,
      };
    });

    return { wallet: wallet_address, total_positions: positions.length, positions };
  } catch (error) {
    log("wallet_positions_error", error.message);
    return { wallet: wallet_address, total_positions: 0, positions: [], error: error.message };
  }
}

// ─── Search Pools by Query ─────────────────────────────────────
export async function searchPools({ query, limit = 10 }) {
  const url = `https://dlmm.datapi.meteora.ag/pools?query=${encodeURIComponent(query)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Pool search API error: ${res.status} ${res.statusText}`);
  const data = await res.json();
  const pools = (Array.isArray(data) ? data : data.data || []).slice(0, limit);
  return {
    query,
    total: pools.length,
    pools: pools.map((p) => ({
      pool: p.address || p.pool_address,
      name: p.name,
      bin_step: p.bin_step ?? p.dlmm_params?.bin_step,
      fee_pct: p.base_fee_percentage ?? p.fee_pct,
      tvl: p.liquidity,
      volume_24h: p.trade_volume_24h,
      token_x: { symbol: p.mint_x_symbol ?? p.token_x?.symbol, mint: p.mint_x ?? p.token_x?.address },
      token_y: { symbol: p.mint_y_symbol ?? p.token_y?.symbol, mint: p.mint_y ?? p.token_y?.address },
    })),
  };
}

/**
 * Read-only peek at a position's current claimable SOL-side (token Y) fees,
 * WITHOUT claiming. Used by the fee-compound gate (executor.js) to decide
 * claim_fees vs compoundFees before sending any transaction, and to compute
 * the shadow-mode "would fire" log while feeCompoundEnabled is off. Same
 * on-chain read `compoundFees` does pre-claim (`pool.getPosition`), just
 * without the write path. Never throws — returns 0 on any read failure so a
 * gate check failure degrades to "don't compound", never blocks claim_fees.
 */
export async function peekUnclaimedSolFees({ position_address }) {
  try {
    position_address = normalizeMint(position_address);
    const wallet = getWallet();
    const poolAddress = await lookupPoolForPosition(position_address, wallet.publicKey.toString());
    const pool = await getPool(poolAddress);
    const positionData = await pool.getPosition(new PublicKey(position_address));
    const processed = positionData?.positionData;
    const feeYLamports = new BN(processed?.feeY || processed?.feeYExcludeTransferFee || 0);
    return feeYLamports.toNumber() / 1e9;
  } catch (error) {
    log("compound_warn", `peekUnclaimedSolFees failed for ${position_address}: ${error.message}`);
    return 0;
  }
}

/**
 * Value a position's claimable fees (raw feeX/feeY from the position account,
 * read PRE-claim — claimSwapFee zeroes them) in SOL and USD at claim-time
 * prices. That is the same basis Meteora's allTimeFees eventually reports, so
 * the claim ledger this feeds (state.recordClaim) agrees with the indexer once
 * it catches up rather than fighting it.
 *
 * Never throws. On a price outage the SOL side still records (usd falls back to
 * 0), so the ledger under-credits rather than over-credits — max() in
 * tools/pnl.js then simply defers to the indexer, i.e. today's behaviour.
 */
async function valueClaimableFees(pool, processed, position_address) {
  try {
    const decX = pool.tokenX?.mint?.decimals ?? 9;
    const decY = pool.tokenY?.mint?.decimals ?? 9;
    // ?? not || — feeX/feeY are BN, and BN(0) is truthy.
    const feeX = safeNum((processed?.feeX ?? processed?.feeXExcludeTransferFee ?? 0).toString()) / 10 ** decX;
    const feeY = safeNum((processed?.feeY ?? processed?.feeYExcludeTransferFee ?? 0).toString()) / 10 ** decY;
    if (feeX <= 0 && feeY <= 0) return { sol: 0, usd: 0, sol_usd_price: 0 };

    const baseMint = pool.lbPair.tokenXMint.toString();
    const prices = await getJupiterPrices([config.tokens.SOL, baseMint]);
    const solUsd = prices[config.tokens.SOL] ?? null;
    const priceX = prices[baseMint] ?? 0;
    const usd = feeX * priceX + feeY * (solUsd ?? 0);
    return {
      sol: solUsd ? usd / solUsd : feeY,
      usd,
      sol_usd_price: solUsd ?? 0,
    };
  } catch (error) {
    log("claim_warn", `Could not value claimed fees for ${position_address} (non-fatal): ${error.message}`);
    return { sol: 0, usd: 0, sol_usd_price: 0 };
  }
}

// ─── Claim Fees ────────────────────────────────────────────────
export async function claimFees({ position_address }) {
  position_address = normalizeMint(position_address);
  if (process.env.DRY_RUN === "true") {
    return { dry_run: true, would_claim: position_address, message: "DRY RUN — no transaction sent" };
  }

  const tracked = getTrackedPosition(position_address);
  if (tracked?.closed) {
    return { success: false, error: "Position already closed — fees were claimed during close" };
  }

  try {
    log("claim", `Claiming fees for position: ${position_address}`);
    const wallet = getWallet();
    const poolAddress = await lookupPoolForPosition(position_address, wallet.publicKey.toString());
    // Clear cached pool so SDK loads fresh position fee state
    poolCache.delete(poolAddress.toString());
    const pool = await getPool(poolAddress);

    const positionData = await pool.getPosition(new PublicKey(position_address));
    // Value the fees BEFORE claiming — claimSwapFee zeroes them out.
    const claimed = await valueClaimableFees(pool, positionData?.positionData, position_address);
    const txs = await pool.claimSwapFee({
      owner: wallet.publicKey,
      position: positionData,
    });

    if (!txs || txs.length === 0) {
      return { success: false, error: "No fees to claim — transaction is empty" };
    }

    const txHashes = [];
    let totalGasLamports = 0;
    for (const tx of txs) {
      const { txHash, fee } = await sendAndConfirmWithRetry(getConnection(), tx, [wallet], "claim:fees");
      txHashes.push(txHash);
      totalGasLamports += fee;
    }
    const claim_gas_sol = totalGasLamports / 1e9;
    log("claim", `SUCCESS txs: ${txHashes.join(", ")} | gas: ${claim_gas_sol.toFixed(6)} SOL | claimed: ◎${claimed.sol.toFixed(6)}`);
    _positionsCacheAt = 0; // invalidate cache after claim
    recordClaim(position_address, claimed);

    return { success: true, position: position_address, txs: txHashes, base_mint: pool.lbPair.tokenXMint.toString(), gas_cost_sol: claim_gas_sol };
  } catch (error) {
    log("claim_error", error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Profit-gated fee compounding (Kamino/Revert Compoundor pattern, plan #08-adjacent).
 * Claims fees, then re-adds the SOL-side (token Y) portion of what was just
 * claimed back into the SAME position — strictly within its existing
 * lower/upper bin range, via the SDK's `addLiquidityByStrategy` on the
 * existing position. This is the exact analog `flipPositionInPlace` already
 * uses for in-place mutation (see that function's Step 3): the SDK supports
 * adding liquidity to an existing position address via
 * `pool.addLiquidityByStrategy({ positionPubKey, user, totalXAmount,
 * totalYAmount, strategy: { minBinId, maxBinId, strategyType }, slippage })`
 * — confirmed in node_modules/@meteora-ag/dlmm (same call flipPositionInPlace
 * makes). There is no SDK gap here; no fallback is needed for the re-add step
 * itself.
 *
 * Base-token (token X) fees are deliberately NOT re-added — per the single-
 * sided SOL semantics this agent deploys under, only the SOL side compounds.
 * The claimed base-token portion is left in the wallet to follow the NORMAL
 * post-claim path (autoSwapAfterClaim / the periodic dust sweep), unchanged.
 *
 * Re-adds within the position's OWN existing [lowerBinId, upperBinId] — never
 * a new/expanded range — so this cannot trip the bin-array-initialization
 * guard that deployPosition enforces (those bins are already initialized;
 * the position already spans them).
 *
 * DRY_RUN and the closed-position guard mirror claimFees. Never throws.
 */
export async function compoundFees({ position_address }) {
  position_address = normalizeMint(position_address);
  if (process.env.DRY_RUN === "true") {
    return { dry_run: true, would_compound: position_address, message: "DRY RUN — no transaction sent" };
  }

  const tracked = getTrackedPosition(position_address);
  if (tracked?.closed) {
    return { success: false, error: "Position already closed — fees were claimed during close" };
  }

  try {
    log("compound", `Compounding fees for position: ${position_address}`);
    const { StrategyType } = await getDLMM();
    const wallet = getWallet();
    const poolAddress = await lookupPoolForPosition(position_address, wallet.publicKey.toString());
    poolCache.delete(poolAddress.toString());
    const pool = await getPool(poolAddress);
    const positionPubKey = new PublicKey(position_address);

    // Read claimable fees BEFORE claiming — claimSwapFee zeroes them out.
    const positionData = await pool.getPosition(positionPubKey);
    const processed = positionData?.positionData;
    if (!processed) return { success: false, error: "Position account not found on-chain for compound." };
    const feeYLamports = new BN(processed.feeY || processed.feeYExcludeTransferFee || 0);
    const feeSolBeforeClaim = feeYLamports.toNumber() / 1e9;
    const claimed = await valueClaimableFees(pool, processed, position_address);

    // ── Step 1: claim (same call as claimFees) ──
    const claimTxs = await pool.claimSwapFee({ owner: wallet.publicKey, position: positionData });
    if (!claimTxs || claimTxs.length === 0) {
      return { success: false, error: "No fees to claim — transaction is empty" };
    }

    const txHashes = [];
    let totalGasLamports = 0;
    for (const tx of claimTxs) {
      const { txHash, fee } = await sendAndConfirmWithRetry(getConnection(), tx, [wallet], "claim:fees");
      txHashes.push(txHash);
      totalGasLamports += fee;
    }
    _positionsCacheAt = 0;
    // Record the FULL claim here, not just the base-token side: at this point the
    // fees really are out of the position, and if the re-add below fails they stay
    // out. The re-added portion is reversed back out once it actually lands.
    recordClaim(position_address, claimed);
    const baseMint = pool.lbPair.tokenXMint.toString();

    if (feeSolBeforeClaim <= 0) {
      const claim_gas_sol = totalGasLamports / 1e9;
      log("compound", `No SOL-side fees to re-add for ${position_address} — claim-only (base-token fees, if any, follow the normal post-claim path)`);
      return {
        success: true,
        compounded: false,
        position: position_address,
        txs: txHashes,
        base_mint: baseMint,
        gas_cost_sol: claim_gas_sol,
        reason: "no_sol_side_fees",
      };
    }

    // ── Step 2: re-add the claimed SOL side into the SAME position, within
    //    its own existing bin range (never expands the range). ──
    const lowerBinId = processed.lowerBinId;
    const upperBinId = processed.upperBinId;
    const strategyMap = { spot: StrategyType.Spot, curve: StrategyType.Curve, bid_ask: StrategyType.BidAsk };
    const strategyType = strategyMap[tracked?.strategy] ?? StrategyType.Spot;

    log("compound", `Re-adding ${feeSolBeforeClaim.toFixed(6)} SOL into ${position_address} (bins ${lowerBinId}->${upperBinId})`);
    const addTx = await pool.addLiquidityByStrategy({
      positionPubKey,
      user: wallet.publicKey,
      totalXAmount: new BN(0),
      totalYAmount: feeYLamports,
      strategy: { minBinId: lowerBinId, maxBinId: upperBinId, strategyType },
      slippage: 1000, // 10% in bps — matches deployPosition's standard-path slippage
    });
    for (const tx of Array.isArray(addTx) ? addTx : [addTx]) {
      const { txHash, fee } = await sendAndConfirmWithRetry(getConnection(), tx, [wallet], "claim:compoundAdd");
      txHashes.push(txHash);
      totalGasLamports += fee;
    }

    const compound_gas_sol = totalGasLamports / 1e9;
    _positionsCacheAt = 0;
    // The SOL side is back inside the position and already counted in its on-chain
    // balance, so it must leave the claim ledger — otherwise the poller counts it
    // both as a claimed fee and as liquidity until the indexer reflects the claim
    // AND the matching deposit. Base-token fees stay in the ledger: they left for
    // the wallet and never came back.
    recordClaimReinvested(position_address, {
      sol: feeSolBeforeClaim,
      usd: feeSolBeforeClaim * claimed.sol_usd_price,
    });
    try {
      addGasToPosition(position_address, compound_gas_sol);
    } catch (e) {
      log("compound_warn", `Gas bookkeeping update failed (non-fatal): ${e.message}`);
    }

    appendDecision({
      type: "compound",
      actor: "MANAGER",
      pool: poolAddress,
      pool_name: tracked?.pool_name || poolAddress.slice(0, 8),
      position: position_address,
      summary: `Compounded ${feeSolBeforeClaim.toFixed(6)} SOL of fees back into the position`,
      reason: "profit-gated fee compound",
      metrics: { compounded_sol: feeSolBeforeClaim, gas_cost_sol: compound_gas_sol },
    });

    log("compound", `SUCCESS compound ${position_address}: ${txHashes.join(", ")} | gas: ${compound_gas_sol.toFixed(6)} SOL`);
    return {
      success: true,
      compounded: true,
      position: position_address,
      pool: poolAddress,
      base_mint: baseMint,
      compounded_sol: feeSolBeforeClaim,
      txs: txHashes,
      gas_cost_sol: compound_gas_sol,
    };
  } catch (error) {
    log("compound_error", error.message);
    return { success: false, compounded: false, error: error.message };
  }
}

// ─── Close Position ────────────────────────────────────────────
export async function closePosition({ position_address, reason, urgent = false }) {
  position_address = normalizeMint(position_address);
  if (process.env.DRY_RUN === "true") {
    return { dry_run: true, would_close: position_address, message: "DRY RUN — no transaction sent" };
  }

  const tracked = getTrackedPosition(position_address);

  try {
    log("close", `Closing position: ${position_address}`);
    const wallet = getWallet();
    const poolAddress = await lookupPoolForPosition(position_address, wallet.publicKey.toString());
    const poolMeta = await getPoolMetadata(poolAddress);
    if (shouldUseLpAgentRelay()) {
      let relaySubmitted = false;
      try {
        const pool = await getPool(poolAddress);
        const relayAllowedDebitMints = [
          pool.lbPair.tokenXMint.toString(),
          pool.lbPair.tokenYMint.toString(),
          config.tokens.SOL,
        ];
        const livePositions = await getMyPositions({ force: true, silent: true });
        const livePosition = livePositions?.positions?.find((position) => position.position === position_address);
        const closeFromBinId = livePosition?.lower_bin ?? tracked?.bin_range?.min ?? -887272;
        const closeToBinId = livePosition?.upper_bin ?? tracked?.bin_range?.max ?? 887272;
        const closeOutput = "allToken1";

        const order = await meridianJson("/execution/zap-out/order", {
          method: "POST",
          headers: getMeridianHeaders(),
          body: JSON.stringify({
            agentId: config.hiveMind.agentId || "agent-local",
            idempotencyKey: `close:${position_address}:10000`,
            positionId: position_address,
            owner: wallet.publicKey.toString(),
            bps: 10000,
            slippageBps: 5000,
            output: closeOutput,
            provider: "OKX",
            type: "meteora",
            fromBinId: closeFromBinId,
            toBinId: closeToBinId,
          }),
        });

        const closeUnsigned = order?.order?.transactions?.close || [];
        const swapUnsigned = order?.order?.transactions?.swap || [];
        if (closeUnsigned.length + swapUnsigned.length === 0) {
          throw new Error("LPAgent close order returned no transactions. Check the position, selected output, and relay order response.");
        }

        const closeSigned = await signAndSimulateRelayTransactions(closeUnsigned, wallet, {
          label: "zap-out close",
          allowedDebitMints: relayAllowedDebitMints,
          maxSolLoss: 0.05,
          requiredStaticAccounts: [wallet.publicKey.toString(), position_address],
        });
        const swapSigned = await signAndSimulateRelayTransactions(swapUnsigned, wallet, {
          label: "zap-out swap",
          allowedDebitMints: relayAllowedDebitMints,
          maxSolLoss: 0.05,
          requiredStaticAccounts: [wallet.publicKey.toString()],
        });

        relaySubmitted = true;
        const submit = await meridianJson("/execution/zap-out/submit", {
          method: "POST",
          headers: getMeridianHeaders(),
          body: JSON.stringify({
            requestId: order.requestId,
            lastValidBlockHeight: order?.order?.lastValidBlockHeight,
            transactions: {
              close: closeSigned,
              swap: swapSigned,
            },
          }),
        });

        const claimTxHashes = [];
        const closeTxHashes = normalizeExecutionSignatures(submit);
        const txHashes = [...claimTxHashes, ...closeTxHashes];

        await new Promise((resolve) => setTimeout(resolve, 5000));
        _positionsCacheAt = 0;

        let closedConfirmed = false;
        for (let attempt = 0; attempt < 4; attempt++) {
          try {
            const refreshed = await getMyPositions({ force: true, silent: true });
            const stillOpen = refreshed?.positions?.some((p) => p.position === position_address);
            if (!stillOpen) {
              closedConfirmed = true;
              break;
            }
            log("close_warn", `Relay close still appears open after submit (attempt ${attempt + 1}/4)`);
          } catch (e) {
            log("close_warn", `Relay close verification failed (attempt ${attempt + 1}/4): ${e.message}`);
          }
          if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 3000));
        }

        if (!closedConfirmed) {
          return {
            success: false,
            error: "Close submit succeeded but position still appears open after verification window",
            position: position_address,
            pool: poolAddress,
            close_txs: closeTxHashes,
            txs: txHashes,
          };
        }

        recordClose(position_address, reason || "agent decision");

        if (tracked) {
          const deployedAt = new Date(tracked.deployed_at).getTime();
          const minutesHeld = Math.floor((Date.now() - deployedAt) / 60000);
          let minutesOOR = 0;
          if (tracked.out_of_range_since) {
            minutesOOR = Math.floor((Date.now() - new Date(tracked.out_of_range_since).getTime()) / 60000);
          }

          let pnlUsd = 0;
          let pnlTrueUsd = 0;
          let pnlSol = 0;
          let pnlPct = 0;
          let finalValueUsd = 0;
          let initialUsd = 0;
          let feesUsd = tracked.total_fees_claimed_usd || 0;
          // Explicit dual-denominated values straight from the API (never
          // solMode-dependent) — used for honest ◎/$ display + record dual-write.
          let depSolTrue = 0, depUsdTrue = 0, feesSolTrue = 0, feesUsdTrue = 0;
          try {
            const closedUrl = `https://dlmm.datapi.meteora.ag/positions/${poolAddress}/pnl?user=${wallet.publicKey.toString()}&status=closed&pageSize=50&page=1`;
            for (let attempt = 0; attempt < 6; attempt++) {
              const res = await fetch(closedUrl);
              if (res.ok) {
                const data = await res.json();
                const posEntry = (data.positions || []).find((entry) => entry.positionAddress === position_address);
                if (posEntry) {
                  pnlTrueUsd = safeNum(posEntry.pnlUsd);
                  pnlSol = getClosedPnlValue(posEntry, true);
                  pnlUsd = config.management.solMode ? pnlSol : pnlTrueUsd;
                  pnlPct = getClosedPnlPct(posEntry, config.management.solMode);
                  finalValueUsd = parseFloat((config.management.solMode ? posEntry.allTimeWithdrawals?.total?.sol : posEntry.allTimeWithdrawals?.total?.usd) || 0);
                  initialUsd = parseFloat((config.management.solMode ? posEntry.allTimeDeposits?.total?.sol : posEntry.allTimeDeposits?.total?.usd) || 0);
                  feesUsd = parseFloat((config.management.solMode ? posEntry.allTimeFees?.total?.sol : posEntry.allTimeFees?.total?.usd) || 0) || feesUsd;
                  depSolTrue = parseFloat(posEntry.allTimeDeposits?.total?.sol || 0);
                  depUsdTrue = parseFloat(posEntry.allTimeDeposits?.total?.usd || 0);
                  feesSolTrue = parseFloat(posEntry.allTimeFees?.total?.sol || 0);
                  feesUsdTrue = parseFloat(posEntry.allTimeFees?.total?.usd || 0);
                  break;
                }
              }
              if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, 5000));
            }
          } catch (e) {
            log("close_warn", `Relay closed PnL fetch failed: ${e.message}`);
          }

          updateClosedPositionPnL(position_address, pnlPct, pnlUsd, feesUsd);

          const closeBaseMint = livePosition?.base_mint || pool.lbPair.tokenXMint.toString();
          const signalSnapshot = resolvePerformanceSignalSnapshot({
            poolAddress,
            baseMint: closeBaseMint,
            tracked,
          });

          let exitMarket = {};
          try {
            const exitDetail = await fetch(`https://pool-discovery-api.datapi.meteora.ag/pools?page_size=1&filter_by=${encodeURIComponent(`pool_address=${poolAddress}`)}&timeframe=${encodeURIComponent(config.screening?.timeframe || "5m")}`).then(r => r.json()).catch(() => null);
            const ep = exitDetail?.data?.[0];
            if (ep) {
              exitMarket = {
                exit_mcap: parseFloat(ep?.token_x?.market_cap) || null,
                exit_tvl: parseFloat(ep?.tvl ?? ep?.active_tvl) || null,
                exit_volume: parseFloat(ep?.volume) || null,
              };
            }
          } catch { /* non-blocking */ }

          await recordPerformance({
            position: position_address,
            pool: poolAddress,
            pool_name: tracked.pool_name || poolMeta.name || poolAddress.slice(0, 8),
            base_mint: closeBaseMint,
            strategy: tracked.strategy,
            bin_range: tracked.bin_range,
            bin_step: tracked.bin_step || null,
            volatility: tracked.volatility ?? null,
            fee_tvl_ratio: tracked.fee_tvl_ratio || null,
            fee_efficiency: tracked.fee_efficiency ?? null,
            organic_momentum: tracked.organic_momentum ?? null,
            organic_score: tracked.organic_score || null,
            amount_sol: tracked.amount_sol,
            pnl_sol: pnlSol,
            pnl_usd_true: pnlTrueUsd,
            fees_sol_true: feesSolTrue || null,
            fees_usd_true: feesUsdTrue || null,
            deposit_sol_true: depSolTrue || null,
            deposit_usd_true: depUsdTrue || null,
            // Price-path features tracked per poller tick (state.js updatePnlAndCheckExits)
            mfe_pnl_pct: tracked.mfe_pnl_pct ?? null,
            mae_pnl_pct: tracked.mae_pnl_pct ?? null,
            max_bins_below: tracked.max_bins_below ?? null,
            max_bins_above: tracked.max_bins_above ?? null,
            peak_pnl_pct: tracked.peak_pnl_pct ?? null,
            // Lifetime TWAP wick-guard deferrals — see the sibling close path below.
            twap_guard_deferrals_total: tracked.twap_guard_deferrals_total ?? null,
            fees_earned_usd: feesUsd,
            final_value_usd: finalValueUsd,
            initial_value_usd: initialUsd,
            minutes_in_range: minutesHeld - minutesOOR,
            minutes_held: minutesHeld,
            close_reason: reason || "agent decision",
            signal_snapshot: signalSnapshot,
            entry_mcap: tracked.entry_mcap ?? null,
            entry_tvl: tracked.entry_tvl ?? null,
            entry_volume: tracked.entry_volume ?? null,
            entry_holders: tracked.entry_holders ?? null,
            deploy_confidence: tracked.deploy_confidence ?? null,
            bear_debate: tracked.bear_debate ?? null,
            ...exitMarket,
          });

          appendDecision({
            type: "close",
            actor: "MANAGER",
            pool: poolAddress,
            pool_name: tracked.pool_name || poolMeta.name || poolAddress.slice(0, 8),
            position: position_address,
            summary: `Relay closed at ${pnlPct.toFixed(2)}%`,
            reason: reason || "agent decision",
            risks: [
              minutesOOR > 0 ? `out of range ${minutesOOR}m` : null,
              tracked.volatility != null ? `volatility ${tracked.volatility}` : null,
            ].filter(Boolean),
            metrics: {
              pnl_usd: pnlUsd,
              pnl_pct: pnlPct,
              fees_usd: feesUsd,
              minutes_held: minutesHeld,
            },
          });

          return {
            success: true,
            relay: true,
            request_id: order.requestId,
            position: position_address,
            pool: poolAddress,
            pool_name: tracked.pool_name || poolMeta.name || null,
            claim_txs: claimTxHashes,
            close_txs: closeTxHashes,
            txs: txHashes,
            pnl_usd: pnlUsd,
            pnl_sol: pnlSol,
            pnl_pct: pnlPct,
            deployed_usd: initialUsd,
            deployed_sol: tracked.amount_sol || 0,
            fees_usd: feesUsd,
            // Explicit dual-denominated fields (never solMode-dependent):
            pnl_usd_true: pnlTrueUsd,
            deployed_sol_true: depSolTrue || tracked.amount_sol || 0,
            deployed_usd_true: depUsdTrue || null,
            fees_sol_true: feesSolTrue || null,
            fees_usd_true: feesUsdTrue || null,
            peak_pnl_pct: tracked.peak_pnl_pct ?? null,
            hold_time: minutesHeld,
            strategy: tracked.strategy || "unknown",
            reason: reason || "agent decision",
            base_mint: closeBaseMint,
          };
        }
      } catch (relayError) {
        if (relaySubmitted) throw relayError;
        log("close_warn", `Relay zap-out failed before submit; falling back to local close + Jupiter autoswap: ${relayError.message}`);
      }
    }

    // Clear cached pool so SDK loads fresh position fee state
    poolCache.delete(poolAddress.toString());
    const pool = await getPool(poolAddress);

    const positionPubKey = new PublicKey(position_address);
    const claimTxHashes = [];
    const closeTxHashes = [];
    let closeGasLamports = 0;

    let alreadyClosed = false;
    try {
      const checkData = await pool.getPosition(positionPubKey);
      if (!checkData) {
        alreadyClosed = true;
        log("close", `Position account ${position_address} does not exist on-chain. Skipping transactions.`);
      }
    } catch (e) {
      const msg = String(e.message || "");
      if (msg.includes("not found") || msg.includes("does not exist") || msg.includes("owned by a different program")) {
        alreadyClosed = true;
        log("close", `Position account ${position_address} not found on-chain (${msg}). Skipping transactions.`);
      } else {
        log("close_warn", `Error checking position account existence: ${e.message}`);
      }
    }

    if (!alreadyClosed) {
      // ─── Step 1: Claim Fees (to clear account state) ───────────
      // Step 2's removeLiquidity({shouldClaimAndClose:true}) claims the same fees
      // in-transaction, so this standalone claim is redundant latency (2 txs,
      // median ~3.5s live) on the exit critical path. On URGENT exits (crash/rug,
      // stop-loss, ratchet, young stop — passed by the caller) skip it when
      // fastCloseSkipClaim is ON; shadow-log the would-skip while OFF. The
      // recentlyClaimed branch below has always taken the same skip path.
      const recentlyClaimed = tracked?.last_claim_at && (Date.now() - new Date(tracked.last_claim_at).getTime()) < 60_000;
      const fastSkipClaim = urgent === true && config.management.fastCloseSkipClaim === true;
      if (urgent === true && !fastSkipClaim && !recentlyClaimed) {
        log("fast_close_shadow", `[FAST_CLOSE_SHADOW] would-skip pre-close claim for ${position_address} (urgent exit; fastCloseSkipClaim=false)`);
      }
      try {
        if (recentlyClaimed) {
          log("close", `Step 1: Skipping claim — fees already claimed ${Math.round((Date.now() - new Date(tracked.last_claim_at).getTime()) / 1000)}s ago`);
        } else if (fastSkipClaim) {
          log("close", `Step 1: Skipping claim — urgent exit + fastCloseSkipClaim (Step 2 claims in-transaction)`);
        } else {
          log("close", `Step 1: Claiming fees for ${position_address}`);
          const positionData = await pool.getPosition(positionPubKey);
          const claimTxs = await pool.claimSwapFee({
            owner: wallet.publicKey,
            position: positionData,
          });
          if (claimTxs && claimTxs.length > 0) {
            for (const tx of claimTxs) {
              const { txHash: claimHash, fee: claimFee } = await sendAndConfirmWithRetry(getConnection(), tx, [wallet], "close:claimFees");
              claimTxHashes.push(claimHash);
              closeGasLamports += claimFee;
            }
            log("close", `Step 1 OK (claim only): ${claimTxHashes.join(", ")}`);
          }
        }
      } catch (e) {
        log("close_warn", `Step 1 (Claim) failed or nothing to claim: ${e.message}`);
      }

      // ─── Step 2: Remove Liquidity & Close ──────────────────────
      let hasLiquidity = false;
      let closeFromBinId = -887272;
      let closeToBinId = 887272;
      try {
        const positionDataForClose = await pool.getPosition(positionPubKey);
        const processed = positionDataForClose?.positionData;
        if (processed) {
          closeFromBinId = processed.lowerBinId ?? closeFromBinId;
          closeToBinId = processed.upperBinId ?? closeToBinId;
          const bins = Array.isArray(processed.positionBinData) ? processed.positionBinData : [];
          hasLiquidity = bins.some((bin) => new BN(bin.positionLiquidity || "0").gt(new BN(0)));
        }
      } catch (e) {
        log("close_warn", `Could not check liquidity state: ${e.message}`);
      }

      if (hasLiquidity) {
        log("close", `Step 2: Removing liquidity and closing account`);
        const closeTx = await pool.removeLiquidity({
          user: wallet.publicKey,
          position: positionPubKey,
          fromBinId: closeFromBinId,
          toBinId: closeToBinId,
          bps: new BN(10000),
          shouldClaimAndClose: true,
        });

        for (const tx of Array.isArray(closeTx) ? closeTx : [closeTx]) {
          const { txHash, fee } = await sendAndConfirmWithRetry(getConnection(), tx, [wallet], "close:removeLiquidity");
          closeTxHashes.push(txHash);
          closeGasLamports += fee;
        }
      } else {
        log("close", `Step 2: No position liquidity detected, closing account`);
        const closeTx = await pool.closePosition({
          owner: wallet.publicKey,
          position: { publicKey: positionPubKey },
        });
        const { txHash, fee } = await sendAndConfirmWithRetry(getConnection(), closeTx, [wallet], "close:emptyAccount");
        closeTxHashes.push(txHash);
        closeGasLamports += fee;
      }
    }
    const txHashes = [...claimTxHashes, ...closeTxHashes];
    const close_gas_sol = closeGasLamports / 1e9;
    log("close", `Step 2 OK (close only): ${closeTxHashes.join(", ") || "none"}`);
    log("close", `SUCCESS txs: ${txHashes.join(", ")} | gas: ${close_gas_sol.toFixed(6)} SOL`);
    // Wait for RPC to reflect withdrawn balances before returning — prevents
    // agent from seeing zero balance when attempting post-close swap
    await new Promise(r => setTimeout(r, 5000));
    _positionsCacheAt = 0;

    let closedConfirmed = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const refreshed = await getMyPositions({ force: true, silent: true });
        const stillOpen = refreshed?.positions?.some((p) => p.position === position_address);
        if (!stillOpen) {
          closedConfirmed = true;
          break;
        }
        log("close_warn", `Position ${position_address} still appears open after close txs (attempt ${attempt + 1}/4)`);
      } catch (e) {
        log("close_warn", `Close verification failed (attempt ${attempt + 1}/4): ${e.message}`);
      }
      if (attempt < 3) await new Promise((r) => setTimeout(r, 3000));
    }

    if (!closedConfirmed) {
      return {
        success: false,
        error: "Close transactions sent but position still appears open after verification window",
        position: position_address,
        pool: poolAddress,
        claim_txs: claimTxHashes,
        close_txs: closeTxHashes,
        txs: txHashes,
      };
    }

    // Authoritative on-chain confirmation: the indexer loop above (getMyPositions)
    // reads the datapi PnL API, which can report a position gone before the account
    // is actually closed (a partial remove or unconfirmed close leaves the account
    // alive). Read the account directly before recording a win — if it still exists,
    // do NOT record performance / mark closed / auto-swap; the next cycle retries.
    const onChainInfo = await getConnection().getAccountInfo(positionPubKey);
    if (onChainInfo !== null) {
      log("close_warn", `Close txs confirmed but position account ${position_address} still exists on-chain — not recording as closed`);
      return {
        success: false,
        status: "close_unconfirmed",
        error: "Close txs sent but position account still exists on-chain — verify/retry",
        position: position_address,
        pool: poolAddress,
        claim_txs: claimTxHashes,
        close_txs: closeTxHashes,
        txs: txHashes,
      };
    }

    recordClose(position_address, reason || "agent decision");

    // Record performance for learning
    if (tracked) {
      const deployedAt = new Date(tracked.deployed_at).getTime();
      const minutesHeld = Math.floor((Date.now() - deployedAt) / 60000);

      let minutesOOR = 0;
      if (tracked.out_of_range_since) {
        minutesOOR = Math.floor((Date.now() - new Date(tracked.out_of_range_since).getTime()) / 60000);
      }

      const shouldRejectClosedPnl = (pct, closeReasonText) => {
        if (!Number.isFinite(pct)) return false;
        const reasonText = String(closeReasonText || "").toLowerCase();
        const stopLossTriggered = reasonText.includes("stop loss");
        // Meteora sometimes briefly reports absurd closed pnl while the record is settling.
        // Trust legitimate stop-loss disasters, but reject obviously unsettled outliers otherwise.
        return !stopLossTriggered && pct <= -90;
      };

      // Fetch closed PnL from API — authoritative source after withdrawal settles
      let pnlUsd = 0;
      let pnlTrueUsd = 0;
      let pnlSol = 0;
      let pnlPct = 0;
      let finalValueUsd = 0;
      let initialUsd = 0;
      let feesUsd = tracked.total_fees_claimed_usd || 0;
      // Explicit dual-denominated values straight from the API (never
      // solMode-dependent) — used for honest ◎/$ display + record dual-write.
      let depSolTrue = 0, depUsdTrue = 0, feesSolTrue = 0, feesUsdTrue = 0;
      try {
        const closedUrl = `https://dlmm.datapi.meteora.ag/positions/${poolAddress}/pnl?user=${wallet.publicKey.toString()}&status=closed&pageSize=50&page=1`;
        for (let attempt = 0; attempt < 6; attempt++) {
          const res = await fetch(closedUrl);
          if (res.ok) {
            const data = await res.json();
            const posEntry = (data.positions || []).find(p => p.positionAddress === position_address);
            if (posEntry) {
              const nextPnlUsd = safeNum(posEntry.pnlUsd);
              const nextPnlSol = getClosedPnlValue(posEntry, true);
              const nextPnlValue = config.management.solMode ? nextPnlSol : nextPnlUsd;
              const nextPnlPct = getClosedPnlPct(posEntry, config.management.solMode);
              const nextFinalValueUsd = parseFloat((config.management.solMode ? posEntry.allTimeWithdrawals?.total?.sol : posEntry.allTimeWithdrawals?.total?.usd) || 0);
              const nextInitialUsd = parseFloat((config.management.solMode ? posEntry.allTimeDeposits?.total?.sol : posEntry.allTimeDeposits?.total?.usd) || 0);
              const nextFeesUsd = parseFloat((config.management.solMode ? posEntry.allTimeFees?.total?.sol : posEntry.allTimeFees?.total?.usd) || 0) || feesUsd;

              if (shouldRejectClosedPnl(nextPnlPct, reason || tracked?.close_reason)) {
                log("close_warn", `Rejected unsettled closed PnL for ${position_address.slice(0, 8)} on attempt ${attempt + 1}/6: ${nextPnlPct.toFixed(2)}%`);
              } else {
                pnlTrueUsd    = nextPnlUsd;
                pnlSol        = nextPnlSol;
                pnlUsd        = nextPnlValue;
                pnlPct        = nextPnlPct;
                finalValueUsd = nextFinalValueUsd;
                initialUsd    = nextInitialUsd;
                feesUsd       = nextFeesUsd;
                depSolTrue    = parseFloat(posEntry.allTimeDeposits?.total?.sol || 0);
                depUsdTrue    = parseFloat(posEntry.allTimeDeposits?.total?.usd || 0);
                feesSolTrue   = parseFloat(posEntry.allTimeFees?.total?.sol || 0);
                feesUsdTrue   = parseFloat(posEntry.allTimeFees?.total?.usd || 0);
                const curStr = config.management.solMode ? "SOL" : "USD";
                const prec = config.management.solMode ? 4 : 2;
                log("close", `Closed PnL from API: pnl=${pnlUsd.toFixed(prec)} ${curStr} (${pnlPct.toFixed(2)}%), withdrawn=${finalValueUsd.toFixed(prec)} ${curStr}, deposited=${initialUsd.toFixed(prec)} ${curStr}`);
                break;
              }
            } else {
              log("close_warn", `Position not found in status=closed response (attempt ${attempt + 1}/6) — may still be settling`);
            }
          }
          if (attempt < 5) await new Promise((r) => setTimeout(r, 5000));
        }
      } catch (e) {
        log("close_warn", `Closed PnL fetch failed: ${e.message}`);
      }
      // Fallback to pre-close cache snapshot if closed API had no data
      if (finalValueUsd === 0) {
        const cachedPos = _positionsCache?.positions?.find(p => p.position === position_address);
        if (cachedPos) {
          pnlTrueUsd    = cachedPos.pnl_true_usd ?? (config.management.solMode ? 0 : cachedPos.pnl_usd) ?? 0;
          pnlSol        = cachedPos.pnl_sol ?? (config.management.solMode ? cachedPos.pnl_usd : 0) ?? 0;
          pnlUsd        = config.management.solMode ? (cachedPos.pnl_usd ?? 0) : pnlTrueUsd;
          pnlPct        = cachedPos.pnl_pct   ?? 0;
          feesUsd       = (cachedPos.collected_fees_true_usd || 0) + (cachedPos.unclaimed_fees_true_usd || 0);
          initialUsd    = tracked.initial_value_usd || 0;
          if (initialUsd > 0) {
            // Keep fallback internally consistent using USD-only cached metrics.
            finalValueUsd = Math.max(0, initialUsd + pnlTrueUsd - feesUsd);
            if (!config.management.solMode) pnlPct = (pnlTrueUsd / initialUsd) * 100;
          } else {
            finalValueUsd = cachedPos.total_value_true_usd ?? cachedPos.total_value_usd ?? 0;
            initialUsd = Math.max(0, finalValueUsd + feesUsd - pnlTrueUsd);
          }
          log("close_warn", `Using cached pnl fallback because closed API has not settled yet`);
        }
      }

      updateClosedPositionPnL(position_address, pnlPct, pnlUsd, feesUsd);

      const closeBaseMint = pool.lbPair.tokenXMint.toString();
      const signalSnapshot = resolvePerformanceSignalSnapshot({
        poolAddress,
        baseMint: closeBaseMint,
        tracked,
      });

      let exitMarket = {};
      try {
        const exitDetail = await fetch(`https://pool-discovery-api.datapi.meteora.ag/pools?page_size=1&filter_by=${encodeURIComponent(`pool_address=${poolAddress}`)}&timeframe=${encodeURIComponent(config.screening?.timeframe || "5m")}`).then(r => r.json()).catch(() => null);
        const ep = exitDetail?.data?.[0];
        if (ep) {
          exitMarket = {
            exit_mcap: parseFloat(ep?.token_x?.market_cap) || null,
            exit_tvl: parseFloat(ep?.tvl ?? ep?.active_tvl) || null,
            exit_volume: parseFloat(ep?.volume) || null,
          };
        }
      } catch { /* non-blocking */ }

      await recordPerformance({
        position: position_address,
        pool: poolAddress,
        pool_name: tracked.pool_name || poolMeta.name || poolAddress.slice(0, 8),
        base_mint: closeBaseMint,
        strategy: tracked.strategy,
        bin_range: tracked.bin_range,
        bin_step: tracked.bin_step || null,
        volatility: tracked.volatility ?? null,
        fee_tvl_ratio: tracked.fee_tvl_ratio || null,
        fee_efficiency: tracked.fee_efficiency ?? null,
        organic_momentum: tracked.organic_momentum ?? null,
        organic_score: tracked.organic_score || null,
        amount_sol: tracked.amount_sol,
        pnl_sol: pnlSol,
        pnl_usd_true: pnlTrueUsd,
        fees_sol_true: feesSolTrue || null,
        fees_usd_true: feesUsdTrue || null,
        deposit_sol_true: depSolTrue || null,
        deposit_usd_true: depUsdTrue || null,
        // Price-path features tracked per poller tick (state.js updatePnlAndCheckExits)
        mfe_pnl_pct: tracked.mfe_pnl_pct ?? null,
        mae_pnl_pct: tracked.mae_pnl_pct ?? null,
        max_bins_below: tracked.max_bins_below ?? null,
        max_bins_above: tracked.max_bins_above ?? null,
        peak_pnl_pct: tracked.peak_pnl_pct ?? null,
        // Lifetime TWAP wick-guard deferrals (shadow or enforced). Makes the guard's
        // real cost measurable per close instead of inferable only from log grepping.
        twap_guard_deferrals_total: tracked.twap_guard_deferrals_total ?? null,
        fees_earned_usd: feesUsd,
        final_value_usd: finalValueUsd,
        initial_value_usd: initialUsd,
        minutes_in_range: minutesHeld - minutesOOR,
        minutes_held: minutesHeld,
        close_reason: reason || "agent decision",
        signal_snapshot: signalSnapshot,
        entry_mcap: tracked.entry_mcap ?? null,
        entry_tvl: tracked.entry_tvl ?? null,
        entry_volume: tracked.entry_volume ?? null,
        entry_holders: tracked.entry_holders ?? null,
        deploy_confidence: tracked.deploy_confidence ?? null,
        bear_debate: tracked.bear_debate ?? null,
        gas_cost_sol: close_gas_sol,
        total_gas_sol: (tracked.total_gas_sol ?? tracked.gas_cost_sol ?? 0) + close_gas_sol,
        ...exitMarket,
      });

      appendDecision({
        type: "close",
        actor: "MANAGER",
        pool: poolAddress,
        pool_name: tracked.pool_name || poolMeta.name || poolAddress.slice(0, 8),
        position: position_address,
        summary: `Closed at ${pnlPct.toFixed(2)}%`,
        reason: reason || "agent decision",
        risks: [
          minutesOOR > 0 ? `out of range ${minutesOOR}m` : null,
          tracked.volatility != null ? `volatility ${tracked.volatility}` : null,
        ].filter(Boolean),
        metrics: {
          pnl_usd: pnlUsd,
          pnl_pct: pnlPct,
          fees_usd: feesUsd,
          minutes_held: minutesHeld,
          gas_cost_sol: close_gas_sol,
          total_gas_sol: (tracked.total_gas_sol ?? tracked.gas_cost_sol ?? 0) + close_gas_sol,
          net_pnl_sol: pnlSol - ((tracked.total_gas_sol ?? tracked.gas_cost_sol ?? 0) + close_gas_sol),
        },
      });

      return {
        success: true,
        position: position_address,
        pool: poolAddress,
        pool_name: tracked.pool_name || poolMeta.name || null,
        claim_txs: claimTxHashes,
        close_txs: closeTxHashes,
        txs: txHashes,
        pnl_usd: pnlUsd,
        pnl_sol: pnlSol,
        pnl_pct: pnlPct,
        deployed_usd: initialUsd,
        deployed_sol: tracked.amount_sol || 0,
        fees_usd: feesUsd,
        // Explicit dual-denominated fields (never solMode-dependent):
        pnl_usd_true: pnlTrueUsd,
        deployed_sol_true: depSolTrue || tracked.amount_sol || 0,
        deployed_usd_true: depUsdTrue || null,
        fees_sol_true: feesSolTrue || null,
        fees_usd_true: feesUsdTrue || null,
        peak_pnl_pct: tracked.peak_pnl_pct ?? null,
        hold_time: minutesHeld,
        strategy: tracked.strategy || "unknown",
        reason: reason || "agent decision",
        base_mint: closeBaseMint,
        gas_cost_sol: close_gas_sol,
        total_gas_sol: (tracked.total_gas_sol ?? tracked.gas_cost_sol ?? 0) + close_gas_sol,
      };
    }

    appendDecision({
      type: "close",
      actor: "MANAGER",
      pool: poolAddress,
      pool_name: poolMeta.name || poolAddress.slice(0, 8),
      position: position_address,
      summary: "Closed position",
      reason: reason || "agent decision",
      metrics: {},
    });

    return {
      success: true,
      position: position_address,
      pool: poolAddress,
      pool_name: poolMeta.name || null,
      claim_txs: claimTxHashes,
      close_txs: closeTxHashes,
      txs: txHashes,
      base_mint: pool.lbPair.tokenXMint.toString(),
    };
  } catch (error) {
    log("close_error", error.message);
    return { success: false, error: error.message };
  }
}

/**
 * OOR-below flip in place (plan #07). Withdraws the position's liquidity WITHOUT
 * closing the account (`shouldClaimAndClose:false`, so bins + rent survive), then
 * re-adds the received base token (token X) single-sided as a bid_ask ask ladder
 * above the current active bin, in the SAME tracked position. A mean-reverting
 * recovery then sells the token back at range prices + earns fees, instead of a
 * close→zap market sell at the local bottom.
 *
 * Only reached when `config.management.oorFlipEnabled` is true AND the flip gates
 * passed (caller decides); this function assumes the decision was already made. It
 * still self-guards the range against the MIN_SAFE_BINS_BELOW floor and refuses if
 * no base token was received. Increments `flip_count` on the tracked position.
 *
 * DRY_RUN short-circuits with a would_flip descriptor and no on-chain tx.
 * Returns { success, flipped, ... } — never throws (wrapped).
 */
export async function flipPositionInPlace({ position_address, reason, strip_bins }) {
  position_address = normalizeMint(position_address);
  const tracked = getTrackedPosition(position_address);
  const stripBins = Math.max(1, Number(strip_bins ?? config.management.swapFreeRedepositBins ?? 20));

  if (process.env.DRY_RUN === "true") {
    return {
      dry_run: true,
      flipped: false,
      would_flip: position_address,
      strip_bins: stripBins,
      message: "DRY RUN — no transaction sent",
    };
  }

  try {
    const { StrategyType } = await getDLMM();
    const wallet = getWallet();
    const poolAddress = await lookupPoolForPosition(position_address, wallet.publicKey.toString());
    const pool = await getPool(poolAddress);
    const positionPubKey = new PublicKey(position_address);

    // Read the live position: its bins, and whether it still holds liquidity.
    const positionData = await pool.getPosition(positionPubKey);
    const processed = positionData?.positionData;
    if (!processed) return { success: false, error: "Position account not found on-chain for flip." };
    const lowerBinId = processed.lowerBinId;
    const upperBinId = processed.upperBinId;
    const bins = Array.isArray(processed.positionBinData) ? processed.positionBinData : [];
    const hasLiquidity = bins.some((bin) => new BN(bin.positionLiquidity || "0").gt(new BN(0)));

    let flipGasLamports = 0;
    const txHashes = [];

    // ── Step 1: withdraw liquidity, KEEP the account (bins + rent survive) ──
    if (hasLiquidity) {
      log("flip", `Flip step 1: withdrawing liquidity (keeping account) for ${position_address}`);
      const withdrawTx = await pool.removeLiquidity({
        user: wallet.publicKey,
        position: positionPubKey,
        fromBinId: lowerBinId ?? -887272,
        toBinId: upperBinId ?? 887272,
        bps: new BN(10000),
        shouldClaimAndClose: false, // <-- the flip: keep the position account alive
      });
      for (const tx of Array.isArray(withdrawTx) ? withdrawTx : [withdrawTx]) {
        const { txHash, fee } = await sendAndConfirmWithRetry(getConnection(), tx, [wallet], "flip:removeLiquidity");
        txHashes.push(txHash);
        flipGasLamports += fee;
      }
    }

    // Let the withdrawn balances settle before reading them.
    await new Promise((r) => setTimeout(r, 5000));
    _positionsCacheAt = 0;

    // ── Step 2: measure the received base token (token X) ──
    const baseMint = pool.lbPair.tokenXMint.toString();
    const mintInfo = await getConnection().getParsedAccountInfo(new PublicKey(baseMint));
    const decimals = mintInfo.value?.data?.parsed?.info?.decimals ?? 9;
    const { getWalletBalances } = await import("./wallet.js");
    const balances = await getWalletBalances({});
    const tokenBal = balances.tokens?.find((t) => t.mint === baseMint);
    const tokenAmount = Number(tokenBal?.balance ?? 0);
    if (!(tokenAmount > 0)) {
      return { success: false, flipped: false, error: "No base token received to re-add — aborting flip (position withdrawn to wallet).", position: position_address, pool: poolAddress, base_mint: baseMint, txs: txHashes };
    }
    const totalXLamports = new BN(Math.floor(tokenAmount * Math.pow(10, decimals)));

    // ── Step 3: re-add token-single-sided as an ask ladder above the active bin ──
    const activeBin = await pool.getActiveBin();
    const minBinId = activeBin.binId + 1;               // strictly above active (all token = ask side)
    const maxBinId = activeBin.binId + stripBins;
    log("flip", `Flip step 3: re-adding token-side ${minBinId}->${maxBinId} (${stripBins} bins, bid_ask ask ladder)`);
    const addTx = await pool.addLiquidityByStrategy({
      positionPubKey,
      user: wallet.publicKey,
      totalXAmount: totalXLamports,
      totalYAmount: new BN(0),
      strategy: { minBinId, maxBinId, strategyType: StrategyType.BidAsk },
      slippage: 1000,
    });
    for (const tx of Array.isArray(addTx) ? addTx : [addTx]) {
      const { txHash, fee } = await sendAndConfirmWithRetry(getConnection(), tx, [wallet], "flip:addLiquidity");
      txHashes.push(txHash);
      flipGasLamports += fee;
    }

    const flip_gas_sol = flipGasLamports / 1e9;

    // Mark the flip on the tracked position: bump flip_count, stamp flipped_at,
    // update the bin_range to the new ask ladder, and clear the OOR timer so the
    // recovered ladder isn't instantly re-flagged. The final eventual close scores
    // the whole arc (recordPerformance runs then, as always).
    try {
      const t = getTrackedPosition(position_address);
      if (t) {
        t.flip_count = Number(t.flip_count ?? 0) + 1;
        t.flipped_at = new Date().toISOString();
        t.bin_range = { min: minBinId, max: maxBinId, bins_below: 0, bins_above: stripBins };
        t.out_of_range_since = null;
        addGasToPosition(position_address, flip_gas_sol);
      }
    } catch (e) {
      log("flip_warn", `Flip bookkeeping update failed (non-fatal): ${e.message}`);
    }

    appendDecision({
      type: "flip",
      actor: "MANAGER",
      pool: poolAddress,
      pool_name: tracked?.pool_name || poolAddress.slice(0, 8),
      position: position_address,
      summary: `Flipped OOR-below → ask ladder ${minBinId}->${maxBinId}`,
      reason: reason || "oor-below flip",
      metrics: { strip_bins: stripBins, gas_cost_sol: flip_gas_sol, token_amount: tokenAmount },
    });

    log("flip", `SUCCESS flip ${position_address}: ${txHashes.join(", ")} | gas: ${flip_gas_sol.toFixed(6)} SOL`);
    return {
      success: true,
      flipped: true,
      position: position_address,
      pool: poolAddress,
      pool_name: tracked?.pool_name || null,
      base_mint: baseMint,
      bin_range: { min: minBinId, max: maxBinId, active: activeBin.binId },
      strip_bins: stripBins,
      txs: txHashes,
      gas_cost_sol: flip_gas_sol,
    };
  } catch (error) {
    log("flip_error", error.message);
    return { success: false, flipped: false, error: error.message };
  }
}

// ─── Helpers ──────────────────────────────────────────────────
async function lookupPoolForPosition(position_address, walletAddress) {
  // Check state registry first (fast path)
  const tracked = getTrackedPosition(position_address);
  if (tracked?.pool) return tracked.pool;

  // Check in-memory positions cache
  const cached = _positionsCache?.positions?.find((p) => p.position === position_address);
  if (cached?.pool) return cached.pool;

  // SDK scan (last resort)
  const { DLMM } = await getDLMM();
  const allPositions = await DLMM.getAllLbPairPositionsByUser(
    getConnection(),
    new PublicKey(walletAddress)
  );

  const entries = allPositions instanceof Map ? allPositions.entries() : Object.entries(allPositions);
  for (const [lbPairKey, positionData] of entries) {
    for (const pos of positionData.lbPairPositionsData || []) {
      if (pos.publicKey.toString() === position_address) return lbPairKey;
    }
  }

  throw new Error(`Position ${position_address} not found in open positions`);
}
