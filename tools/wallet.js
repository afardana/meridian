import {
  Connection,
  PublicKey,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
  Keypair,
  Transaction,
} from "@solana/web3.js";
import { getAssociatedTokenAddress, createCloseAccountInstruction } from "@solana/spl-token";
import bs58 from "bs58";
import { log } from "../logger.js";
import { config } from "../config.js";
import { setSolPriceUsd } from "../sol-price.js";

let _connection = null;
let _wallet = null;

function getConnection() {
  if (!_connection) _connection = new Connection(process.env.RPC_URL, { commitment: "confirmed", disableRequestBatching: true });
  return _connection;
}

function getWallet() {
  if (!_wallet) {
    if (!process.env.WALLET_PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY not set");
    _wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
  }
  return _wallet;
}

/** The agent's wallet public key (base58), or null if the key isn't configured. */
export function getWalletAddress() {
  try {
    return getWallet().publicKey.toString();
  } catch {
    return null;
  }
}

const JUPITER_PRICE_API = "https://api.jup.ag/price/v3";
const JUPITER_SWAP_V2_API = "https://api.jup.ag/swap/v2";
const DEFAULT_JUPITER_API_KEY = "b15d42e9-e0e4-4f90-a424-ae41ceeaa382";

function getJupiterApiKey() {
  return config.jupiter.apiKey || process.env.JUPITER_API_KEY || DEFAULT_JUPITER_API_KEY;
}

function getJupiterReferralParams() {
  const referralAccount = String(config.jupiter.referralAccount || "").trim();
  const referralFee = Number(config.jupiter.referralFeeBps || 0);
  if (!referralAccount || !Number.isFinite(referralFee) || referralFee <= 0) {
    return null;
  }
  if (referralFee < 50 || referralFee > 255) {
    log("swap_warn", `Ignoring Jupiter referral fee ${referralFee}; Ultra requires 50-255 bps`);
    return null;
  }
  try {
    new PublicKey(referralAccount);
  } catch {
    log("swap_warn", "Ignoring invalid Jupiter referral account");
    return null;
  }
  return { referralAccount, referralFee: Math.round(referralFee) };
}

/**
 * Get current wallet balances: SOL, USDC, and all SPL tokens using Helius Wallet API.
 * Returns USD-denominated values provided by Helius.
 */
export async function getWalletBalances() {
  let walletAddress;
  try {
    walletAddress = getWallet().publicKey.toString();
  } catch {
    return { wallet: null, sol: 0, sol_price: 0, sol_usd: 0, usdc: 0, tokens: [], total_usd: 0, error: "Wallet not configured" };
  }

  const HELIUS_KEY = process.env.HELIUS_API_KEY;
  if (!HELIUS_KEY) {
    log("wallet_error", "HELIUS_API_KEY not set in .env");
    return { wallet: walletAddress, sol: 0, sol_price: 0, sol_usd: 0, usdc: 0, tokens: [], total_usd: 0, error: "Helius API key missing" };
  }

  const maxRetries = 3;
  let delay = 1000;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const url = `https://api.helius.xyz/v1/wallet/${walletAddress}/balances?api-key=${HELIUS_KEY}`;
      const res = await fetch(url);
      
      if (!res.ok) {
        throw new Error(`Helius API error: ${res.status} ${res.statusText}`);
      }

      const data = await res.json();
      const balances = data.balances || [];

      // ─── Find SOL and USDC ────────────────────────────────────
      const solEntry = balances.find(b => b.mint === config.tokens.SOL || b.symbol === "SOL");
      const usdcEntry = balances.find(b => b.mint === config.tokens.USDC || b.symbol === "USDC");

      const solBalance = solEntry?.balance || 0;
      const solPrice = solEntry?.pricePerToken || 0;
      const solUsd = solEntry?.usdValue || 0;
      if (solPrice > 0) setSolPriceUsd(solPrice); // feed the shared display-price cache
      const usdcBalance = usdcEntry?.balance || 0;

      // ─── Map all tokens ───────────────────────────────────────
      const enrichedTokens = balances.map(b => ({
        mint: b.mint,
        symbol: b.symbol || b.mint.slice(0, 8),
        balance: b.balance,
        usd: b.usdValue ? Math.round(b.usdValue * 100) / 100 : null,
      }));

      // ─── Calculate Deployed Value & AUM ───────────────────────
      let deployedSol = 0;
      let deployedUsd = 0;
      let unclaimedFeesSol = 0;
      let unclaimedFeesUsd = 0;
      let rentSol = 0;
      let rentUsd = 0;

      try {
        const { getMyPositions } = await import("./dlmm.js");
        const result = await getMyPositions({ force: true, silent: true });
        if (result && Array.isArray(result.positions)) {
          for (const p of result.positions) {
            const val = p.total_value_usd || 0;
            const unclaimed = p.unclaimed_fees_usd || 0;
            const METEORA_DLMM_RENT_SOL = 0.065;

            if (config.management.solMode) {
              // val and unclaimed are in SOL
              deployedSol += val;
              deployedUsd += val * solPrice;
              unclaimedFeesSol += unclaimed;
              unclaimedFeesUsd += unclaimed * solPrice;
            } else {
              // val and unclaimed are in USD
              deployedUsd += val;
              deployedSol += solPrice > 0 ? (val / solPrice) : 0;
              unclaimedFeesUsd += unclaimed;
              unclaimedFeesSol += solPrice > 0 ? (unclaimed / solPrice) : 0;
            }
            rentSol += METEORA_DLMM_RENT_SOL;
            rentUsd += METEORA_DLMM_RENT_SOL * solPrice;
          }
        }
      } catch (e) {
        log("wallet_error", `Failed to retrieve deployed positions for AUM: ${e.message}`);
      }

      // Recoverable rent locked in the wallet's token accounts (one ATA per
      // position's base token, ~0.002 SOL each). It's our SOL — just held in
      // separate accounts that getBalance() doesn't see — so counting it keeps
      // AUM flat across open/close instead of dipping when an ATA is created or
      // stranded empty. (Part A reclaims it; this keeps the graph honest meanwhile.)
      let recoverableRentSol = 0;
      try {
        const conn = getConnection();
        const ownerPk = new PublicKey(walletAddress);
        const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
        const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
        for (const prog of [TOKEN_PROGRAM, TOKEN_2022]) {
          const res = await conn.getParsedTokenAccountsByOwner(ownerPk, { programId: prog });
          for (const { account } of res.value) recoverableRentSol += account.lamports / LAMPORTS_PER_SOL;
        }
      } catch (e) {
        log("wallet_warn", `Failed to read token-account rent for AUM: ${e.message}`);
      }
      const recoverableRentUsd = recoverableRentSol * solPrice;

      const idleSol = solBalance;
      const idleUsd = solUsd;
      const totalSol = idleSol + deployedSol + unclaimedFeesSol + rentSol + recoverableRentSol;
      const totalUsdVal = (data.totalUsdValue || 0) + deployedUsd + unclaimedFeesUsd + rentUsd + recoverableRentUsd;

      return {
        wallet: walletAddress,
        sol: Math.round(solBalance * 1e6) / 1e6,
        sol_price: Math.round(solPrice * 100) / 100,
        sol_usd: Math.round(solUsd * 100) / 100,
        usdc: Math.round(usdcBalance * 100) / 100,
        tokens: enrichedTokens,
        aum: {
          idle_sol: Math.round(idleSol * 1e6) / 1e6,
          idle_usd: Math.round(idleUsd * 100) / 100,
          deployed_sol: Math.round(deployedSol * 1e6) / 1e6,
          deployed_usd: Math.round(deployedUsd * 100) / 100,
          unclaimed_sol: Math.round(unclaimedFeesSol * 1e6) / 1e6,
          unclaimed_usd: Math.round(unclaimedFeesUsd * 100) / 100,
          rent_sol: Math.round(rentSol * 1e6) / 1e6,
          rent_usd: Math.round(rentUsd * 100) / 100,
          recoverable_rent_sol: Math.round(recoverableRentSol * 1e6) / 1e6,
          recoverable_rent_usd: Math.round(recoverableRentUsd * 100) / 100,
          total_sol: Math.round(totalSol * 1e6) / 1e6,
          total_usd: Math.round(totalUsdVal * 100) / 100,
        },
        total_usd: Math.round(totalUsdVal * 100) / 100,
      };
    } catch (error) {
      log("wallet_error", `Attempt ${attempt}/${maxRetries} failed: ${error.message}`);
      if (attempt === maxRetries) {
        return {
          wallet: walletAddress,
          sol: 0,
          sol_price: 0,
          sol_usd: 0,
          usdc: 0,
          tokens: [],
          total_usd: 0,
          error: error.message,
        };
      }
      await new Promise(r => setTimeout(r, delay));
      delay *= 2.5;
    }
  }
}

/**
 * Swap tokens via Jupiter Swap API V2 (order → sign → execute).
 */
const SOL_MINT = "So11111111111111111111111111111111111111112";

// Normalize any SOL-like address to the correct wrapped SOL mint
export function normalizeMint(mint) {
  if (!mint) return mint;
  const SOL_MINT = "So11111111111111111111111111111111111111112";
  if (
    mint === "SOL" || 
    mint === "native" || 
    /^So1+$/.test(mint) || 
    (mint.length >= 32 && mint.length <= 44 && mint.startsWith("So1") && mint !== SOL_MINT)
  ) {
    return SOL_MINT;
  }
  return mint;
}

export async function swapToken({
  input_mint,
  output_mint,
  amount,
}) {
  input_mint  = normalizeMint(input_mint);
  output_mint = normalizeMint(output_mint);

  if (process.env.DRY_RUN === "true") {
    return {
      dry_run: true,
      would_swap: { input_mint, output_mint, amount },
      message: "DRY RUN — no transaction sent",
    };
  }

  try {
    log("swap", `${amount} of ${input_mint} → ${output_mint}`);
    const wallet = getWallet();
    const connection = getConnection();

    // ─── Convert to smallest unit ──────────────────────────────
    let decimals = 9; // SOL default
    if (input_mint !== config.tokens.SOL) {
      const mintInfo = await connection.getParsedAccountInfo(new PublicKey(input_mint));
      decimals = mintInfo.value?.data?.parsed?.info?.decimals ?? 9;
    }
    const amountStr = Math.floor(amount * Math.pow(10, decimals)).toString();

    // ─── Get Swap V2 order (unsigned tx + requestId) ───────────
    const search = new URLSearchParams({
      inputMint: input_mint,
      outputMint: output_mint,
      amount: amountStr,
      taker: wallet.publicKey.toString(),
    });
    const referralParams = getJupiterReferralParams();
    if (referralParams) {
      search.set("referralAccount", referralParams.referralAccount);
      search.set("referralFee", String(referralParams.referralFee));
    }
    const orderUrl = `${JUPITER_SWAP_V2_API}/order?${search.toString()}`;
    const jupiterApiKey = getJupiterApiKey();

    const orderRes = await fetch(orderUrl, {
      headers: jupiterApiKey ? { "x-api-key": jupiterApiKey } : {},
    });
    if (!orderRes.ok) {
      const body = await orderRes.text();
      throw new Error(`Swap V2 order failed: ${orderRes.status} ${body}`);
    }

    const order = await orderRes.json();
    if (order.errorCode || order.errorMessage) {
      throw new Error(`Swap V2 order error: ${order.errorMessage || order.errorCode}`);
    }

    const { transaction: unsignedTx, requestId } = order;

    // ─── Deserialize and sign ─────────────────────────────────
    const tx = VersionedTransaction.deserialize(Buffer.from(unsignedTx, "base64"));
    tx.sign([wallet]);
    const signedTx = Buffer.from(tx.serialize()).toString("base64");

    // ─── Execute ───────────────────────────────────────────────
    const execRes = await fetch(`${JUPITER_SWAP_V2_API}/execute`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(jupiterApiKey ? { "x-api-key": jupiterApiKey } : {}),
      },
      body: JSON.stringify({ signedTransaction: signedTx, requestId }),
    });
    if (!execRes.ok) {
      throw new Error(`Swap V2 execute failed: ${execRes.status} ${await execRes.text()}`);
    }

    const result = await execRes.json();
    if (result.status === "Failed") {
      throw new Error(`Swap failed on-chain: code=${result.code}`);
    }

    log("swap", `SUCCESS tx: ${result.signature}`);
    if (referralParams && order.feeBps !== referralParams.referralFee) {
      log(
        "swap_warn",
        `Jupiter referral fee requested ${referralParams.referralFee} bps but order applied ${order.feeBps ?? "unknown"} bps`,
      );
    }

    // Look up the actual swap gas fee, retrying (tx often not yet queryable
    // in the moment right after confirmation — see fetchTxFeeLamports).
    let swap_gas_lamports = 5000;
    try {
      const conn = new Connection(process.env.RPC_URL, { commitment: "confirmed", disableRequestBatching: true });
      const { fetchTxFeeLamports } = await import("./dlmm.js");
      swap_gas_lamports = await fetchTxFeeLamports(conn, result.signature);
    } catch (_) { /* use default */ }

    return {
      success: true,
      tx: result.signature,
      input_mint,
      output_mint,
      amount_in: result.inputAmountResult,
      amount_out: result.outputAmountResult,
      referral_account: referralParams?.referralAccount || null,
      referral_fee_bps_requested: referralParams?.referralFee || 0,
      fee_bps_applied: order.feeBps ?? null,
      fee_mint: order.feeMint ?? null,
      gas_cost_sol: swap_gas_lamports / 1e9,
    };
  } catch (error) {
    log("swap_error", error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Programmatically calculate baseline capital by scanning on-chain deposits.
 * Excludes self-signed transactions (operations) and micro-dust spam transfers.
 */
export async function getBaselineDeposits() {
  let connection, walletAddress;
  try {
    connection = getConnection();
    walletAddress = getWallet().publicKey;
  } catch (err) {
    return { error: "Wallet or Connection not configured: " + err.message };
  }

  const walletStr = walletAddress.toString();
  try {
    const { getBaselineState, saveBaselineState } = await import("../state.js");
    const { callRpc } = await import("./rpc.js");
    const baseline = getBaselineState();

    const fetchOpts = { limit: 1000 };
    if (baseline.last_signature) {
      fetchOpts.until = baseline.last_signature;
    }

    const signatures = await callRpc(conn => conn.getSignaturesForAddress(walletAddress, fetchOpts));

    if (signatures.length > 0) {
      // Process new signatures oldest to newest
      const sortedSignatures = [...signatures].reverse();

      for (const sigInfo of sortedSignatures) {
        // Add a 150ms delay between calls to respect Helius free-tier rate limits (10 RPS)
        await new Promise(resolve => setTimeout(resolve, 150));

        const tx = await callRpc(conn => conn.getParsedTransaction(sigInfo.signature, {
          maxSupportedTransactionVersion: 0,
          commitment: "confirmed"
        }));

        if (!tx) continue;

        // Check if the wallet is a signer (skip trades, claims, etc.)
        const isSigner = tx.transaction.message.accountKeys.some(
          (acc) => acc.pubkey.toBase58() === walletStr && acc.signer
        );
        if (isSigner) continue;

        // Find balance change for our wallet
        const accountIndex = tx.transaction.message.accountKeys.findIndex(
          (acc) => acc.pubkey.toBase58() === walletStr
        );
        if (accountIndex === -1) continue;

        const pre = tx.meta.preBalances[accountIndex];
        const post = tx.meta.postBalances[accountIndex];
        const change = post - pre;

        // Filter out micro-spam transfers (< 0.01 SOL)
        if (change > 10000000) {
          const changeSol = change / 1e9;
          baseline.deposits.push({
            signature: sigInfo.signature,
            timestamp: new Date(sigInfo.blockTime * 1000).toISOString(),
            amount: changeSol
          });
          baseline.total_deposited += changeSol;
        }
      }

      // Save the newest signature as the last_signature cache checkpoint
      baseline.last_signature = signatures[0].signature;
      baseline.total_deposited = Math.round(baseline.total_deposited * 1e6) / 1e6;
      saveBaselineState(baseline);
    }

    return {
      wallet: walletStr,
      total_deposited: baseline.total_deposited,
      deposit_count: baseline.deposits.length,
      deposits: baseline.deposits
    };
  } catch (err) {
    return { error: "Failed to calculate baseline: " + err.message };
  }
}

/**
 * Close an empty Associated Token Account (ATA) to reclaim 0.002 SOL rent.
 * Skip native or wrapped SOL accounts.
 */
export async function closeEmptyTokenAccount(mintAddress) {
  const mintStr = normalizeMint(mintAddress);
  const SOL_MINT = "So11111111111111111111111111111111111111112";
  if (mintStr === SOL_MINT) {
    return { success: false, reason: "Skipped native/wrapped SOL" };
  }

  try {
    const wallet = getWallet();
    const conn = getConnection();
    const mint = new PublicKey(mintStr);
    const ata = await getAssociatedTokenAddress(mint, wallet.publicKey);

    // Verify account exists and balance is 0
    const balanceInfo = await conn.getTokenAccountBalance(ata).catch(() => null);
    if (!balanceInfo) {
      return { success: false, reason: "Account does not exist" };
    }

    const balance = parseFloat(balanceInfo.value.amount);
    if (balance > 0) {
      log("wallet", `Token account ${ata.toString()} still has balance ${balance}, skipping close`);
      return { success: false, reason: "Account has non-zero balance" };
    }

    log("wallet", `Closing empty token account ${ata.toString()} for mint ${mintStr}`);
    const ix = createCloseAccountInstruction(
      ata,
      wallet.publicKey, // destination for reclaimed rent
      wallet.publicKey, // owner authority
      []
    );

    const tx = new Transaction().add(ix);
    const { blockhash } = await conn.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = wallet.publicKey;

    const signature = await conn.sendTransaction(tx, [wallet]);
    await conn.confirmTransaction(signature, "confirmed");

    log("wallet", `Successfully closed empty token account. Tx: ${signature}`);
    return { success: true, tx: signature };
  } catch (e) {
    log("wallet_error", `Failed to close empty token account: ${e.message}`);
    return { success: false, error: e.message };
  }
}

/**
 * Sweep ALL empty (balance-0) token accounts on the wallet, batch-closing them in
 * one tx to reclaim their rent (~0.002 SOL each). Catch-all for ATAs the
 * post-close reclaim misses (dust-skipped swaps, skip_swap, failures, historical).
 * Handles both Token and Token-2022 programs. DRY_RUN-aware. Sends via RPC_URL
 * (rebate-eligible). Caps per run to keep the tx within size limits.
 */
export async function sweepEmptyTokenAccounts({ max = 25 } = {}) {
  const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
  const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
  try {
    const wallet = getWallet();
    const conn = getConnection();
    const owner = wallet.publicKey;

    const empties = [];
    for (const programId of [TOKEN_PROGRAM, TOKEN_2022]) {
      const res = await conn.getParsedTokenAccountsByOwner(owner, { programId });
      for (const { pubkey, account } of res.value) {
        const amt = account.data.parsed.info.tokenAmount;
        if (amt.amount === "0" || amt.uiAmount === 0) {
          empties.push({ pubkey, programId, lamports: account.lamports });
        }
      }
    }

    if (empties.length === 0) return { closed: 0, reclaimed_sol: 0, found: 0 };

    const batch = empties.slice(0, max);
    const reclaimedSol = Math.round((batch.reduce((s, e) => s + e.lamports, 0) / LAMPORTS_PER_SOL) * 1e6) / 1e6;

    if (process.env.DRY_RUN === "true") {
      log("wallet", `[DRY_RUN] Would close ${batch.length} empty token account(s), reclaiming ~${reclaimedSol} SOL (${empties.length} found).`);
      return { closed: 0, reclaimed_sol: reclaimedSol, found: empties.length, dry_run: true };
    }

    const tx = new Transaction();
    for (const e of batch) {
      tx.add(createCloseAccountInstruction(e.pubkey, owner, owner, [], e.programId));
    }
    const { blockhash } = await conn.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = owner;
    const signature = await conn.sendTransaction(tx, [wallet]);
    await conn.confirmTransaction(signature, "confirmed");

    const remaining = empties.length - batch.length;
    log("wallet", `Swept ${batch.length} empty token account(s), reclaimed ~${reclaimedSol} SOL${remaining > 0 ? ` (${remaining} remaining)` : ""}. Tx: ${signature}`);
    return { closed: batch.length, reclaimed_sol: reclaimedSol, found: empties.length, remaining, tx: signature };
  } catch (e) {
    log("wallet_error", `sweepEmptyTokenAccounts failed: ${e.message}`);
    return { closed: 0, reclaimed_sol: 0, error: e.message };
  }
}

