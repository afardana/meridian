import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { config } from "../config.js";
import { log } from "../logger.js";
import {
  getWallet,
  getWalletAddress,
  getWalletBalances,
  getConnection,
} from "./wallet.js";
import { getBaselineState, saveBaselineState } from "../state.js";

// Safety Constants
export const DEFAULT_TARGET_WORKING_CAPITAL_SOL = 6.2529;
export const DEFAULT_MIN_TRANSFER_AMOUNT_SOL = 0.5;
export const DEFAULT_MIN_WALLET_RESERVE_SOL = 0.1;
export const DEFAULT_TRANSFER_INTERVAL_MIN = 60;
export const DEFAULT_MAX_DAILY_TRANSFER_SOL = 2.0;
const PRIORITY_FEE_MICRO_LAMPORTS = 50_000;

// In-memory transfer ledger for rate limiting / daily velocity tracking
const _transferHistory = [];
let _transferLock = false;

/**
 * Validate that a Solana address is a valid on-curve Base58 public key,
 * and is distinct from the agent's own wallet address.
 *
 * @param {string} address
 * @returns {{ valid: boolean, error?: string, pubkey?: PublicKey }}
 */
export function validateDestinationAddress(address) {
  if (!address || typeof address !== "string") {
    return { valid: false, error: "Destination address is required" };
  }
  const cleanAddr = address.trim();
  let pubkey;
  try {
    pubkey = new PublicKey(cleanAddr);
  } catch {
    return { valid: false, error: "Invalid Base58 Solana public key format" };
  }
  if (!PublicKey.isOnCurve(pubkey.toBuffer())) {
    return { valid: false, error: "Address is not an on-curve ed25519 public key (PDA not supported as withdrawal target)" };
  }
  try {
    const ownWallet = getWalletAddress();
    if (ownWallet && pubkey.toBase58() === ownWallet) {
      return { valid: false, error: "Destination address cannot be the agent's own wallet address" };
    }
  } catch {
    // Non-fatal if wallet is not yet initialized
  }
  return { valid: true, pubkey };
}

/**
 * Calculate total SOL transferred within a sliding 24-hour window.
 * @param {number} now
 * @returns {number} SOL transferred in last 24h
 */
export function get24hTransferredSol(now = Date.now()) {
  const windowStart = now - 24 * 60 * 60 * 1000;
  // Prune entries older than 48 hours
  while (_transferHistory.length > 0 && _transferHistory[0].timestamp < now - 48 * 60 * 60 * 1000) {
    _transferHistory.shift();
  }
  return _transferHistory
    .filter((entry) => entry.timestamp >= windowStart)
    .reduce((sum, entry) => sum + entry.amountSol, 0);
}

/**
 * Get timestamp of the most recent transfer.
 * @returns {number|null}
 */
export function getLastTransferTimestamp() {
  if (_transferHistory.length === 0) return null;
  return _transferHistory[_transferHistory.length - 1].timestamp;
}

/**
 * Get comprehensive auto-skim status and transferable balance.
 *
 * @param {object} opts
 * @param {boolean} opts.freshPositions Whether to re-fetch live positions value
 * @returns {Promise<object>}
 */
export async function getAutoSkimStatus({ freshPositions = false } = {}) {
  const skimConfig = config.autoSkim || {};
  const destination = (process.env.PIONEX_DEPOSIT_ADDRESS || skimConfig.destinationAddress || "").trim();
  const validation = validateDestinationAddress(destination);

  const targetWorkingCapitalSol = Number(skimConfig.targetWorkingCapitalSol ?? DEFAULT_TARGET_WORKING_CAPITAL_SOL);
  const minTransferAmountSol = Number(skimConfig.minTransferAmountSol ?? DEFAULT_MIN_TRANSFER_AMOUNT_SOL);
  const minWalletReserveSol = Number(skimConfig.minWalletReserveSol ?? DEFAULT_MIN_WALLET_RESERVE_SOL);
  const transferIntervalMin = Number(skimConfig.transferIntervalMin ?? DEFAULT_TRANSFER_INTERVAL_MIN);
  const maxDailyTransferSol = Number(skimConfig.maxDailyTransferSol ?? DEFAULT_MAX_DAILY_TRANSFER_SOL);

  let baseline = {};
  try {
    baseline = getBaselineState() || {};
  } catch {
    // Non-fatal if called before initState()
  }
  const baselineSol = Number(baseline.total_deposited || 0);
  const totalWithdrawnSol = Number(baseline.total_withdrawn || 0);
  const netCapitalAtRisk = Math.max(0, baselineSol - totalWithdrawnSol);

  const balances = await getWalletBalances({ freshPositions });
  const walletFreeSol = Number(balances.sol || 0);
  // Plan #15 item 4: getWalletBalances exposes deployed_sol (positionsValueSol never
  // existed, so equity silently equalled free SOL and "target working capital" was
  // measured against the wrong base).
  const positionsValueSol = Number(balances.deployed_sol ?? balances.positionsValueSol ?? 0);
  const totalEquitySol = walletFreeSol + positionsValueSol;

  // Surplus above target working capital
  const surplusSol = Math.max(0, totalEquitySol - targetWorkingCapitalSol);

  // Maximum transferable in cash without violating the gas reserve
  const transferableCashSol = Math.max(0, walletFreeSol - minWalletReserveSol);
  const transferableSol = Math.min(surplusSol, transferableCashSol);

  const now = Date.now();
  const lastTransferAt = getLastTransferTimestamp();
  const cooldownMs = transferIntervalMin * 60 * 1000;
  const inCooldown = lastTransferAt != null && now - lastTransferAt < cooldownMs;
  const cooldownRemainingSec = inCooldown ? Math.ceil((cooldownMs - (now - lastTransferAt)) / 1000) : 0;

  // Plan #15 item 4: the in-memory ledger resets on every PM2 restart; floor it with
  // the persisted baseline withdrawals of the last 24h (counts operator withdrawals
  // too — over-capping is the safe direction).
  const persisted24h = (baseline.withdrawals || [])
    .filter((w) => { const ms = new Date(w?.timestamp || 0).getTime(); return Number.isFinite(ms) && now - ms < 24 * 60 * 60 * 1000; })
    .reduce((s, w) => s + (Number(w.amount) || 0), 0);
  const transferredLast24h = Math.max(get24hTransferredSol(now), persisted24h);
  const dailyCapReached = transferredLast24h >= maxDailyTransferSol;

  let blockReason = null;
  if (!skimConfig.enabled) blockReason = "auto_skim_disabled";
  else if (!validation.valid) blockReason = validation.error;
  else if (inCooldown) blockReason = `cooldown_active_${cooldownRemainingSec}s`;
  else if (dailyCapReached) blockReason = `daily_cap_reached_${transferredLast24h.toFixed(2)}/${maxDailyTransferSol}SOL`;
  else if (surplusSol < minTransferAmountSol) blockReason = `surplus_below_threshold_${surplusSol.toFixed(4)}<${minTransferAmountSol}SOL`;
  else if (transferableCashSol < minTransferAmountSol) blockReason = `insufficient_free_sol_${walletFreeSol.toFixed(4)}_reserve_${minWalletReserveSol}SOL`;

  const canTransfer = blockReason === null;

  return {
    enabled: !!skimConfig.enabled,
    destination: validation.valid ? destination : null,
    destinationValid: validation.valid,
    destinationError: validation.error || null,
    targetWorkingCapitalSol,
    netCapitalAtRisk: Math.round(netCapitalAtRisk * 1e4) / 1e4,
    totalEquitySol: Math.round(totalEquitySol * 1e4) / 1e4,
    walletFreeSol: Math.round(walletFreeSol * 1e4) / 1e4,
    positionsValueSol: Math.round(positionsValueSol * 1e4) / 1e4,
    surplusSol: Math.round(surplusSol * 1e4) / 1e4,
    transferableSol: Math.round(transferableSol * 1e4) / 1e4,
    minTransferAmountSol,
    minWalletReserveSol,
    inCooldown,
    cooldownRemainingSec,
    transferredLast24h: Math.round(transferredLast24h * 1e4) / 1e4,
    maxDailyTransferSol,
    dailyCapReached,
    canTransfer,
    blockReason,
  };
}

/**
 * Execute an on-chain SOL transfer to the destination address.
 * Strictly enforces destination validation, gas reserves, cooldowns, and daily limits.
 *
 * @param {object} params
 * @param {string} params.destination Base58 recipient address
 * @param {number} params.amountSol Amount in SOL to transfer
 * @param {string} [params.reason="profit_skim"] Audit reason
 * @returns {Promise<{ success: boolean, tx?: string, amountSol?: number, destination?: string, error?: string }>}
 */
export async function transferSol({ destination, amountSol, reason = "profit_skim" }) {
  if (_transferLock) {
    return { success: false, error: "A transfer is currently in progress. Please wait." };
  }

  _transferLock = true;
  try {
    const cleanDest = (destination || "").trim();
    const validation = validateDestinationAddress(cleanDest);
    if (!validation.valid) {
      log("transfer_error", `Transfer rejected: ${validation.error}`);
      return { success: false, error: validation.error };
    }

    const numAmount = Number(amountSol);
    if (!Number.isFinite(numAmount) || numAmount <= 0) {
      return { success: false, error: "Transfer amount must be a positive number" };
    }
    if (numAmount < 0.01) {
      return { success: false, error: "Transfer amount must be at least 0.01 SOL (anti-dust floor)" };
    }

    const skimConfig = config.autoSkim || {};
    const minWalletReserveSol = Number(skimConfig.minWalletReserveSol ?? DEFAULT_MIN_WALLET_RESERVE_SOL);
    const maxDailyTransferSol = Number(skimConfig.maxDailyTransferSol ?? DEFAULT_MAX_DAILY_TRANSFER_SOL);

    // Verify wallet free balance
    const wallet = getWallet();
    const conn = getConnection();
    const balanceLamports = await conn.getBalance(wallet.publicKey, "confirmed");
    const balanceSol = balanceLamports / LAMPORTS_PER_SOL;

    if (balanceSol - numAmount < minWalletReserveSol) {
      const msg = `Transfer of ◎${numAmount.toFixed(4)} rejected: remaining balance ◎${(balanceSol - numAmount).toFixed(4)} would fall below gas reserve floor of ◎${minWalletReserveSol.toFixed(4)}`;
      log("transfer_warn", msg);
      return { success: false, error: msg };
    }

    // Verify 24h daily cap
    const now = Date.now();
    const transferred24h = get24hTransferredSol(now);
    if (transferred24h + numAmount > maxDailyTransferSol) {
      const msg = `Transfer of ◎${numAmount.toFixed(4)} rejected: would exceed 24h daily cap of ◎${maxDailyTransferSol} (already transferred: ◎${transferred24h.toFixed(4)})`;
      log("transfer_warn", msg);
      return { success: false, error: msg };
    }

    const lamports = Math.round(numAmount * LAMPORTS_PER_SOL);
    const tx = new Transaction();

    // Priority fee to ensure reliable inclusion
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_FEE_MICRO_LAMPORTS }));

    // Native SOL transfer instruction
    tx.add(SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: validation.pubkey,
      lamports,
    }));

    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = wallet.publicKey;

    // Pre-flight simulation
    try {
      const sim = await conn.simulateTransaction(tx, [wallet]);
      if (sim.value?.err) {
        const simErr = `Simulation failed: ${JSON.stringify(sim.value.err)}`;
        log("transfer_error", simErr);
        return { success: false, error: simErr };
      }
    } catch (e) {
      log("transfer_warn", `Simulation warning: ${e.message}; proceeding with broadcast`);
    }

    log("transfer", `Broadcasting transfer of ◎${numAmount.toFixed(4)} ($${(numAmount * (config.solPriceUsd || 0)).toFixed(2)}) to ${cleanDest.slice(0, 4)}…${cleanDest.slice(-4)} (${reason})`);
    const signature = await conn.sendTransaction(tx, [wallet]);

    // Poll confirmation
    await confirmTransfer(conn, signature, blockhash, lastValidBlockHeight);

    // Record in local transfer history
    _transferHistory.push({
      timestamp: Date.now(),
      amountSol: numAmount,
      destination: cleanDest,
      signature,
      reason,
    });

    // Synchronize baseline withdrawals ledger
    try {
      const baseline = getBaselineState();
      baseline.withdrawals ??= [];
      baseline.total_withdrawn = Number(baseline.total_withdrawn || 0) + numAmount;
      baseline.withdrawals.push({
        signature,
        amount: numAmount,
        destination: cleanDest,
        timestamp: new Date().toISOString(),
        reason,
      });
      baseline.total_withdrawn = Math.round(baseline.total_withdrawn * 1e6) / 1e6;
      saveBaselineState(baseline);
    } catch (e) {
      log("transfer_warn", `Failed to record withdrawal in baseline state: ${e.message}`);
    }

    const remainingSol = Math.max(0, balanceSol - numAmount);
    log("transfer", `Transfer confirmed: ◎${numAmount.toFixed(4)} to ${cleanDest.slice(0, 4)}…${cleanDest.slice(-4)}. Tx: ${signature}. Remaining wallet: ◎${remainingSol.toFixed(4)}`);

    return {
      success: true,
      tx: signature,
      amountSol: numAmount,
      destination: cleanDest,
      remainingSol: Math.round(remainingSol * 1e4) / 1e4,
      reason,
    };
  } catch (err) {
    log("transfer_error", `Transfer failed: ${err.message}`);
    return { success: false, error: err.message };
  } finally {
    _transferLock = false;
  }
}

/**
 * Confirm transaction via blockhash and signature polling.
 */
async function confirmTransfer(conn, signature, blockhash, lastValidBlockHeight) {
  try {
    if (blockhash && lastValidBlockHeight) {
      const res = await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
      if (res?.value?.err) throw new Error(`Transaction failed on-chain: ${JSON.stringify(res.value.err)}`);
      return;
    }
  } catch (e) {
    if (e.message && e.message.includes("Transaction failed")) throw e;
  }
  const start = Date.now();
  while (Date.now() - start < 45000) {
    const status = await conn.getSignatureStatus(signature);
    if (status?.value?.confirmationStatus === "confirmed" || status?.value?.confirmationStatus === "finalized") {
      if (status.value.err) throw new Error(`Transaction failed on-chain: ${JSON.stringify(status.value.err)}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
  throw new Error("Transfer confirmation timed out after 45s");
}

/**
 * Evaluate auto-skim conditions and execute autonomous transfer if eligible.
 * Called periodically by the daemon.
 *
 * @param {object} [opts]
 * @param {Function} [opts.onSuccess] Callback when transfer succeeds (e.g. dispatch Telegram)
 * @returns {Promise<{ ran: boolean, reason?: string, result?: object }>}
 */
export async function checkAndExecuteAutoSkim({ onSuccess } = {}) {
  const status = await getAutoSkimStatus({ freshPositions: false });
  if (!status.canTransfer) {
    return { ran: false, reason: status.blockReason };
  }

  // Transfer in discrete chunks of minTransferAmountSol (e.g. 0.50 SOL)
  const transferChunk = Math.floor(status.transferableSol / status.minTransferAmountSol) * status.minTransferAmountSol;
  const finalAmount = Math.round(transferChunk * 1e4) / 1e4;

  if (finalAmount < status.minTransferAmountSol) {
    return { ran: false, reason: `amount_below_chunk_${finalAmount}<${status.minTransferAmountSol}` };
  }

  // Plan #15 item 4: honour requireTelegramConfirmation (it was read nowhere). With
  // it on, the autonomous path never signs a transfer — it proposes; `/skim now` is
  // the operator's confirmation.
  if (config.autoSkim?.requireTelegramConfirmation !== false) {
    log("auto_skim", `Skim proposal (confirmation required): ◎${finalAmount} to ${status.destination.slice(0, 4)}…${status.destination.slice(-4)} — awaiting operator /skim now`);
    return { ran: false, reason: "confirmation_required", proposedAmountSol: finalAmount, status };
  }

  log("auto_skim", `Autonomous profit skim triggered: transferring ◎${finalAmount} to Pionex (${status.destination.slice(0, 4)}…${status.destination.slice(-4)})`);

  const result = await transferSol({
    destination: status.destination,
    amountSol: finalAmount,
    reason: "auto_skim_pionex",
  });

  if (result.success && typeof onSuccess === "function") {
    try {
      await onSuccess(result, status);
    } catch (e) {
      log("auto_skim_warn", `onSuccess notification handler failed: ${e.message}`);
    }
  }

  return { ran: true, result };
}
